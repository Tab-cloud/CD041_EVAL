/**
 * Agent Loop — 核心 Agent 执行循环
 *
 * 流程:
 *   User Message → Agent 选择 → ModelRouter → LLM Stream →
 *   Text Delta (→前端) → Tool Call → Tool Execute → Result →
 *   回填 messages → 继续 LLM 循环 → Finish
 *
 * 仿 OpenCode llm.ts 架构但极度简化:
 *   - 无事件溯源 (单用户桌面应用不需要)
 *   - 无 Fiber 并发 (单工具顺序执行)
 *   - 跨轮语义压缩由 server-context 负责，本循环保留单次工具链的实时上下文
 */

import { ToolRegistry } from "../tool/registry.ts"
import { AgentRegistry } from "../agent/registry.ts"
import { ModelRouter } from "../model-router/index.ts"
import { estimateProjectedHistoryShape, llmClient, type LLMEvent } from "./llm-client.ts"
import {
  isFaultDomainFailure,
  isModelExternalBlocker,
  llmManager,
  modelFaultDomain,
  prioritizeFallbackDomains,
  summarizeModelFailure,
} from "./llm-manager.ts"
import { buildReflectionPrompt, generateFixSuggestions } from "./reflection.ts"
import { checkpointManager } from "../store/checkpoint.ts"
import { hasConfiguredProjectTarget, loadProjectConfig } from "../store/project-config.ts"
import { resolve } from "node:path"
import type { AgentActivityEvent, ToolContext } from "../tool/types.ts"
import {
  filterToolsForScope,
  type ExecutionScope,
} from "./tool-policy.ts"
import { buildSystemPrompt, buildUserContent } from "./agent-prompt.ts"
import { runtimeAccessManager } from "./runtime-access.ts"
import { randomUUID } from "node:crypto"
import {
  ModelProtocolCapabilityRepo,
  modelProtocolIdentity,
} from "../store/model-protocol-capability.ts"
import {
  observeNativeToolProtocolFailure,
  observeNativeToolProtocolSuccess,
} from "./model-protocol-observation.ts"
import {
  ExecutionController,
  type ExecutionTodo as RuntimeTodo,
} from "./agent-loop-control.ts"
import { ExecutionEvidenceLedger } from "../tool/execution-evidence.ts"
import {
  containsTextualToolProtocol,
  ModelOutputPolicy,
  redactInternalImplementationDetails,
} from "./model-output-policy.ts"
import { finalDeliveryEvents, finalDeliveryPolicy } from "./final-delivery.ts"
import { executionControlPolicy } from "./execution-control-policy.ts"
import { logOrchestrationEvent } from "./orchestration-log.ts"
import { DEFAULT_EXECUTION_BUDGET_POLICY, type ExecutionBudgetPolicy } from "./execution-budget.ts"
import { contextInputBudget, PROTOCOL_MESSAGE_LIMIT } from "./context-compaction.ts"
import { normalizeInboundToolCall } from "./tool-call-normalization.ts"
import { restrictToolsToExecutablePlan } from "./executable-plan.ts"
import {
  resolveRecoveryToolPolicy,
  resolveRequiredPhaseToolPolicy,
} from "./recovery-tool-policy.ts"
import {
  buildActiveRecoveryInstruction,
  buildEvidenceRecoveryInstruction,
} from "./recovery-contract.ts"
import {
  EMPTY_MODEL_TURN_ERROR,
  EXECUTABLE_MANUAL_HANDOFF_ERROR,
  detectExecutableManualHandoff,
  validateModelTurnDelivery,
} from "./agent-delivery-contract.ts"
import { turnLoopPolicy } from "./turn-loop-policy.ts"
import { executeToolBatch } from "./agent-loop-tool-execution.ts"
import {
  extractCompileErrors,
  formatToolResultForContext,
  orderCandidateChainForFeedback,
  shouldAnnounceModelRoute,
} from "./agent-loop-support.ts"
import { buildAgentLoopMessages } from "./agent-loop-messages.ts"
import { isRootOnlyTool, resolveAgentAuthority } from "./agent-authority.ts"
import {
  bindAttachmentEvidenceToRequirements,
  mergeObjectiveEvidenceBindings,
  normalizeObjectiveEvidenceBindings,
} from "./objective-evidence-ledger.ts"
import type { AgentLoopContext, AgentLoopInput } from "./agent-loop-types.ts"
export type { AgentLoopContext, AgentLoopInput } from "./agent-loop-types.ts"
export { normalizeToolCallName } from "./tool-call-normalization.ts"
export {
  buildActiveRecoveryInstruction,
  buildEvidenceRecoveryInstruction,
} from "./recovery-contract.ts"
export {
  formatToolResultForContext,
  orderCandidateChainForFeedback,
  requestParentApproval,
  requestParentQuestion,
  resolveToolUserInteraction,
  shouldAnnounceModelRoute,
} from "./agent-loop-support.ts"

// ══════════════════════════════════════════════
// Agent Loop
// ══════════════════════════════════════════════

export class AgentLoop {
  private toolRegistry: ToolRegistry
  private agentRegistry: AgentRegistry
  private modelRouter: ModelRouter
  private maxSteps: number

  constructor(ctx: AgentLoopContext, maxSteps = 15) {
    this.toolRegistry = ctx.toolRegistry
    this.agentRegistry = ctx.agentRegistry
    this.modelRouter = ctx.modelRouter
    this.maxSteps = maxSteps
  }

  /**
   * 执行 Agent 循环，返回异步事件生成器
   */
  async *run(input: AgentLoopInput): AsyncGenerator<LLMEvent & { _step?: number }> {
    const objectiveAcceptancePolicy = input.objectiveAcceptancePolicy
      ?? input.executionState?.objective?.acceptancePolicy
    // 1. 获取 Agent
    const agent = this.agentRegistry.get(input.agentId) ?? this.agentRegistry.getDefault()
    if (!agent) {
      yield { type: "error", message: "当前执行角色不可用，请检查 Agent 配置", _step: 0 }
      return
    }
    if (agent.projectPath && resolve(agent.projectPath).toLowerCase() !== resolve(input.workingDir).toLowerCase()) {
      yield { type: "error", message: "当前执行角色不适用于这个工作区，请检查项目级 Agent 配置", _step: 0 }
      return
    }
    const authorityAgent = resolveAgentAuthority(
      agent,
      this.agentRegistry.list(),
      input.runType,
      input.workingDir,
    )

    // 2. 模型路由（静默——不暴露给用户）
    // 如果用户上传了图片附件，优先使用视觉模型（按优先级排序后的第一个）
    const hasImage = input.attachments?.some((a) => a.kind === "image") ?? false
    let routing: ReturnType<typeof this.modelRouter.route>
    const preferredModel = input.preferredModelId
      ? this.modelRouter.getModel(input.preferredModelId)
      : undefined
    if (preferredModel) {
      routing = {
        model: preferredModel,
        matchedCapability: preferredModel.capabilities[0] ?? "chat",
        score: 1,
        alternatives: [],
        reason: `用户选择模型 ${preferredModel.name} (${preferredModel.modelId})`,
      }
    } else if (hasImage) {
      const visionModel = this.modelRouter.getModelForCapability("vision")
      if (visionModel) {
        routing = {
          model: visionModel,
          matchedCapability: "vision",
          score: 1,
          alternatives: [],
          reason: `图片附件，优先使用视觉模型 ${visionModel.name}`,
        }
      } else {
        // 没有视觉模型：fallback 到正常路由（图片会被降级为文本提示）
        const requiredCapabilities = [...(input.requiredCapabilities ?? agent.requiredCapabilities)]
        if (!requiredCapabilities.includes("vision")) requiredCapabilities.push("vision")
        routing = this.modelRouter.route(requiredCapabilities)
      }
    } else {
      routing = this.modelRouter.route(input.requiredCapabilities ?? agent.requiredCapabilities)
    }
    // 通知 server 实际路由到的模型（用于调用日志 / Token 统计）
    // 3. 获取工具（agent 白名单、权限规则和执行范围共同门控）
    const disabledTools = new Set(input.disabledTools ?? [])
    const phaseControlTools = new Set(input.phaseControlTools ?? [])
    const toolNames = restrictToolsToExecutablePlan(authorityAgent.tools.filter((name) =>
      !disabledTools.has(name)
    ), input.activePlan)
    const initialScope = input.scope ?? "auto-edit"
    const permissionContextId = input.permissionContextId ?? input.sessionId
    const runtimeTimestamp = new Date().toISOString()
    const availableTools = this.toolRegistry.list().filter((tool) => !tool.isAvailable || tool.isAvailable({ workingDir: input.workingDir }))
    const resolveVisibleTools = (scope: ExecutionScope) => {
      const currentNames = [...toolNames]
      // todowrite is execution control-plane state, not a domain capability.
      // Every role receives it so a read-only planning role cannot strand a
      // multi-stage run without an authoritative task graph.
      if (!disabledTools.has("todowrite") && !currentNames.includes("todowrite")) currentNames.push("todowrite")
      for (const name of phaseControlTools) {
        if (input.runType !== "root" && isRootOnlyTool(name)) continue
        if (!disabledTools.has(name) && !currentNames.includes(name)) currentNames.push(name)
      }
      return filterToolsForScope(
        { ...authorityAgent, tools: currentNames },
        availableTools,
        scope,
        input.toolPolicy,
      )
    }

    // 4. 构建模型协议消息
    const supportsVision = routing.model.capabilities?.includes("vision") ?? false
    const { messages, userContent } = buildAgentLoopMessages(
      input,
      supportsVision,
    )

    // DEBUG: 打印模型路由和消息格式
    const hasAttachments = (input.attachments?.length ?? 0) > 0
    const hasImages = input.attachments?.some(a => a.kind === "image") ?? false
    const contentType = Array.isArray(userContent) ? "multimodal" : "text"
    console.log(`[agent-loop] routing.model=${routing.model.name}(${routing.model.modelId}), provider=${routing.model.provider}, supportsVision=${supportsVision}, hasAttachments=${hasAttachments}, hasImages=${hasImages}, userContentType=${contentType}`)
    if (Array.isArray(userContent)) {
      console.log(`[agent-loop] userContent parts:`, userContent.map(p => p.type === "text" ? `text(${p.text?.length}chars)` : p.type === "image_url" ? `image_url(${p.image_url?.url?.substring(0, 50)}...)` : p.type).join(", "))
    }

    // 5. Agent 循环
    // 实时流式输出：工具执行中逐行推送到底部面板
    const pendingStreams: Array<{ target: string; name: string; text: string; type: string }> = []
    const pendingActivities: AgentActivityEvent[] = []
    const pendingNestedEvents: any[] = []
    let wakeStream: (() => void) | null = null
    const waitForStream = () => pendingStreams.length > 0 || pendingActivities.length > 0 || pendingNestedEvents.length > 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => { wakeStream = resolve })

    // Runtime settings are normally normalized before reaching the loop, but
    // tests and embedded callers may provide a deliberately narrow partial
    // lease. Merge at the boundary so every safety field is always present.
    const executionBudget: ExecutionBudgetPolicy = {
      ...DEFAULT_EXECUTION_BUDGET_POLICY,
      ...input.executionBudget,
    }
    const toolCtx: ToolContext = {
      runId: input.runId ?? input.sessionId,
      parentRunId: input.parentRunId,
      runType: input.runType,
      executionSegment: input.executionSegment ?? 0,
      executionStep: 0,
      sessionId: input.sessionId,
      permissionContextId,
      agentId: agent.id,
      workingDir: input.workingDir,
      agentRegistry: this.agentRegistry,
      toolRegistry: this.toolRegistry,
      modelRouter: this.modelRouter,
      __depth: (input as any).__depth,
      scope: initialScope,
      abortSignal: input.abortSignal,
      toolPolicy: input.toolPolicy,
      resourceClaims: input.resourceClaims,
      activePlan: input.activePlan,
      searchConfig: input.searchConfig,
      modelFallbackEnabled: input.modelFallbackEnabled,
      preferredModelId: routing.model.id,
      agentModelRoutes: input.agentModelRoutes,
      fallbackModelIds: input.fallbackModelIds,
      disabledSkillIds: input.disabledSkills,
      streamOutput: (target, line, type) => {
        pendingStreams.push({ target, name: "", text: line, type })
        wakeStream?.()
        wakeStream = null
      },
      onAgentActivity: (activity) => {
        pendingActivities.push(activity)
        input.activityOutput?.(activity)
        wakeStream?.()
        wakeStream = null
      },
      onAgentEvent: (event) => {
        pendingNestedEvents.push(event)
        wakeStream?.()
        wakeStream = null
      },
      onSubAgentInteraction: input.onSubAgentInteraction,
      evidence: new ExecutionEvidenceLedger(input.workingDir),
      executionDeadline: input.executionDeadline ?? Date.now() + executionBudget.rootWindowMs,
      executionBudget,
      executionGate: input.executionGate,
    }

    const configuredSteps = agent.maxSteps > 0 ? Math.min(50, agent.maxSteps) : this.maxSteps
    const runMaxSteps = Math.min(configuredSteps, input.maxStepsOverride ?? 50)
    let executionDeadline = toolCtx.executionDeadline!
    const controllerObjective = objectiveAcceptancePolicy
      ? {
          content: input.userMessage,
          acceptance: objectiveAcceptancePolicy.requirements
            .map((item) => item.label).join("；"),
          acceptancePolicy: objectiveAcceptancePolicy,
          conversationObjectiveId: input.conversationObjective?.id,
          conversationObjectiveFingerprint: input.conversationObjective?.fingerprint,
        }
      : input.executionState?.objective
        ? {
            ...input.executionState.objective,
            conversationObjectiveId: input.conversationObjective?.id
              ?? input.executionState.objective.conversationObjectiveId,
            conversationObjectiveFingerprint: input.conversationObjective?.fingerprint
              ?? input.executionState.objective.conversationObjectiveFingerprint,
          }
        : undefined
    const attachmentEvidence = bindAttachmentEvidenceToRequirements(
      objectiveAcceptancePolicy,
      input.attachments,
    )
    const initialExecutionState = attachmentEvidence.length > 0
      ? {
          ...input.executionState?.initial,
          objectiveEvidenceBindings: mergeObjectiveEvidenceBindings(
            normalizeObjectiveEvidenceBindings(
              input.executionState?.initial?.objectiveEvidenceBindings,
            ),
            attachmentEvidence,
          ),
        }
      : input.executionState?.initial
    const execution = new ExecutionController(runMaxSteps, 50, Math.max(1_000, executionDeadline - Date.now()), 3, {
      ...input.executionState,
      initial: initialExecutionState,
      budgetPolicy: executionBudget,
      initialTodos: input.executionState?.initial?.todos?.length
        ? undefined
        : input.objectiveTodos?.map((content, index) => ({
            content,
            status: index === 0 ? "in_progress" as const : "pending" as const,
            priority: "high" as const,
            acceptance: "该项已通过相关原生工具执行结果形成可追溯证据",
          })),
      objective: controllerObjective,
    })
    const applyPendingGuidance = () => {
      if (input.runType !== "root" || !input.drainGuidance) return []
      const pending = input.drainGuidance()
      if (pending.length === 0) return []
      execution.acceptUserGuidance(pending.map((item) => item.message))
      for (const item of pending) {
        messages.push({
          role: "user",
          content: buildUserContent(
            `## 用户对当前任务的实时补充\n${item.message}\n\n这是同一次任务的补充要求。请结合已有上下文和证据调整当前方案；继续遵守原有权限、审批与安全边界。`,
            item.attachments,
            supportsVision,
          ),
        })
      }
      return pending
    }
    let lastAnnouncedModel = ""
    let stopAnnounced = false
    let outputContinuationSegments = 0
    let protocolRepairAttempts = 0
    let manualHandoffRepairAttempts = 0
    // The controller owns budget, progress and termination. Every safety stop
    // converges on a tool-free final response instead of escaping this loop.
    for (let step = 0; ; step++) {
      toolCtx.executionStep = step
      if (input.abortSignal?.aborted) {
        execution.interrupt("用户取消了任务")
        return
      }
      const boundaryGuidance = applyPendingGuidance()
      for (const guidance of boundaryGuidance) {
        yield {
          type: "guidance-applied",
          requestId: guidance.requestId,
          message: guidance.message,
          _step: step,
        } as any
      }
      const executionDecision = execution.checkTime()
      const round = execution.currentRound()
      const finalizationOnly = round.phase === "finalization"
      const isRootRun = input.runType === "root"
      if (finalizationOnly && executionDecision.stopReason === "time-limit"
        && isRootRun && execution.canRenewTimeWindow()) {
        const continued = execution.renewTimeWindow()
        executionDeadline = Date.now() + toolCtx.executionBudget!.rootWindowMs
        toolCtx.executionDeadline = executionDeadline
        messages.push({
          role: "user",
          content: `运行时已为同一目标续租第 ${continued.continuations! + 1} 个执行窗口。仍有 ${execution.outstandingWorkCount()} 项未验收工作。保留已有证据，从当前待办继续执行；不得把时间窗口边界当成任务完成或要求用户输入“请继续”。`,
        })
        yield {
          type: "execution-continued",
          reason: "time-limit",
          segment: continued.continuations,
          outstandingTodos: execution.outstandingWorkCount(),
          _step: step,
        } as any
        continue
      }
      if (finalizationOnly && isRootRun
        && execution.canContinueAfterBoundary(toolCtx.executionBudget!.maxStagnantSegments)) {
        const boundary = executionDecision.stopReason ?? "budget-exhausted"
        const continued = execution.continueAfterBoundary()
        messages.push({
          role: "user",
          content: `运行时已开启同一目标的第 ${continued.continuations! + 1} 个执行段。上一段因 ${boundary} 结束，但仍有 ${execution.outstandingWorkCount()} 项未验收工作。保留已有证据，改变无效策略并从当前待办继续；不要向用户请求“请继续”。`,
        })
        yield {
          type: "execution-continued",
          reason: boundary,
          segment: continued.continuations,
          outstandingTodos: execution.outstandingWorkCount(),
          _step: step,
        } as any
        continue
      }
      if (finalizationOnly && executionDecision.stopReason && !stopAnnounced) {
        stopAnnounced = true
        yield {
          type: "execution-stopped",
          reason: executionDecision.stopReason ?? "budget-exhausted",
          outstandingTodos: execution.outstandingWorkCount(),
          outstandingSummary: execution.outstandingWorkSummary(),
          _step: step,
        } as any
      }
      yield {
        type: "agent-progress",
        phase: finalizationOnly
          ? "finalization"
          : execution.currentRecovery()
            ? "repair"
            : "model",
        step: round.progressStep,
        maxSteps: execution.currentLimit(),
        _step: step,
      } as any
      const currentScope = runtimeAccessManager.getScope(permissionContextId, initialScope)
      const tools = resolveVisibleTools(currentScope)
      const visibleToolNames = new Set(tools.map((tool) => tool.name))
      const missingPhaseTools = (input.requiredPhaseTools ?? [])
        .filter((name) => !visibleToolNames.has(name))
      if (!finalizationOnly && missingPhaseTools.length > 0) {
        logOrchestrationEvent({
          sessionId: input.sessionId,
          runId: input.runId ?? input.sessionId,
          parentRunId: input.parentRunId,
          agentId: agent.id,
          eventType: "execution.contract-advisory",
          level: "warning",
          message: "Execution phase advice references unavailable tools; continuing with the authorized surface",
          data: {
            scope: currentScope,
            requiredPhaseTools: input.requiredPhaseTools ?? [],
            phaseControlTools: [...phaseControlTools],
            visibleTools: [...visibleToolNames],
            missingPhaseTools,
          },
        })
      }
      const toolSchemas = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        effects: tool.contract.effects,
        progressRole: tool.contract.progress.role,
      }))
      toolCtx.scope = currentScope
      // 构建请求
      // 首轮有图片时，不传 tools —— 部分 vision 模型（如 mimo）在有 tools 时无法正确解析内联图片
      // 后续轮次正常传 tools，模型根据首轮的文字描述执行操作
      const skipTools = step === 0 && hasImage && supportsVision
      const activeRecovery = execution.currentRecovery()
      const requiredPhaseToolPending = (input.requiredPhaseTools?.length ?? 0) > 0
      const requireRecoveryTool = !finalizationOnly && !skipTools
        && executionControlPolicy.requiresNativeTool({
          activeRecovery: Boolean(activeRecovery),
          requiredPhaseToolPending,
          consecutiveNoProgress: execution.snapshot().consecutiveNoProgress,
          outstandingWorkCount: execution.outstandingWorkCount(),
        })
      const recoveryPolicy = !finalizationOnly && activeRecovery
        ? resolveRecoveryToolPolicy(toolSchemas, execution.nextRunnableTodo(), activeRecovery)
        : requireRecoveryTool
          ? resolveRequiredPhaseToolPolicy(toolSchemas, input.requiredPhaseTools ?? [])
          : undefined
      const activeToolSchemas = recoveryPolicy?.tools ?? toolSchemas
      const requireNativeTool = Boolean(requireRecoveryTool && recoveryPolicy?.requireTool)
      const recoveryInstruction = recoveryPolicy?.instruction
      let systemPrompt: string
      if (finalizationOnly) {
        systemPrompt = [
          buildSystemPrompt(agent, input.workingDir, currentScope, input.workflowContext, input.disabledSkills, [], runtimeTimestamp),
          "",
          "## 最终总结阶段",
          "- 工具执行轮次已经结束，本轮不再调用任何工具。",
          "- 根据已有工具结果给出准确、简洁的最终结论。",
          "- 成功时说明已完成的工作和验证结果；失败时说明尚未解决的真实错误与证据。",
          ...execution.finalizationInstructions().map((line) => `- ${line}`),
        ].join("\n")
      } else if (skipTools) {
        // 首轮有图片：使用精简 system prompt，避免模型幻觉工具调用
        const pjCfg = loadProjectConfig(input.workingDir)
        const visionLines = [
          agent.systemPrompt,
          "",
          "## 运行环境",
          `- 工作目录: ${input.workingDir}`,
          `- 当前时间: ${new Date().toISOString()}`,
          `- 操作系统: ${process.platform}`,
        ]
        // 项目配置（精简版，仅芯片信息）
        const chipInfo = hasConfiguredProjectTarget(pjCfg)
          ? [ "", "## 项目配置", `- 芯片: ${pjCfg.project.chip} (${pjCfg.project.chip_family} 系列)`, `- 工具链: ${pjCfg.build.toolchain} (${pjCfg.build.build_system})` ]
          : []
        visionLines.push(
          ...chipInfo,
          "",
          "## 重要：图片处理",
          "- 用户上传的图片已内联附加到消息中，你可以直接看到图片内容。",
          "- 请直接用文字描述或分析图片内容，**不要输出任何工具调用或 JSON 格式的工具请求**。",
          "- 如果用户要求执行操作（如写代码），先用文字描述图片内容，后续轮次再使用工具。",
        )
        systemPrompt = visionLines.join("\n")
      } else {
        systemPrompt = [
          buildSystemPrompt(agent, input.workingDir, currentScope, input.workflowContext, input.disabledSkills, activeToolSchemas.map((tool) => tool.name), runtimeTimestamp),
          "",
          "## 轻量执行循环",
          "- 根据任务需要直接分析、调用工具或给出结果；多阶段工作可以用 todowrite 记录进度，但任务清单不是完成协议。",
          "- 原生工具调用成功后读取结果并继续下一轮；没有待处理工具调用且结果已经可以交付时，直接给出最终回答。",
          "- 工具失败是反馈信号；先读取诊断并改变参数、路径或方案，不得原样重复同一失败调用。",
          "- Agent 任务清单只包含本轮可执行工作。J-Link 烧录、接线、观察示波器/串口等需要用户手动完成、但不属于用户本轮明确验收目标的事项，必须写入 todowrite.followups，不能作为 blocked todo 阻塞交付。",
          "- 只有确实依赖用户决定、批准、外部硬件或当前不可用资源时才说明阻塞；未关闭的 todo 或辅助证据不得让已经可交付的回答失败。",
          "- 不要要求用户输入‘请继续’来推进仍可执行的任务，也不要向用户暴露内部角色、路由、工具清单或调度实现。",
          ...(recoveryPolicy ? [
            "",
            requireNativeTool ? "## 当前必要控制动作" : "## 当前诊断与恢复建议",
            ...(activeRecovery ? [
              `- 上一工具 \`${activeRecovery.sourceTool}\` 失败：${activeRecovery.summary}`,
              `- 恢复阶段 ${activeRecovery.actionIndex + 1}/${activeRecovery.actions.length}：${recoveryInstruction}`,
              "- 完成当前结构化恢复步骤后继续其余步骤；恢复契约关闭不等于目标通过，最终仍以原目标验收证据为准。",
            ] : recoveryInstruction ? [`- ${recoveryInstruction}`] : []),
            ...(requireNativeTool ? [
              "- 本轮必须先通过原生工具调用通道完成用户所选执行阶段要求的控制动作。",
              "- 不得用正文描述、伪造 JSON、DSML 或代码块代替工具调用。",
            ] : [
              "- 上述恢复步骤只是建议，不限制可用工具，也不要求重复失败调用。",
              "- 可直接改参数、改路径、改方案、重新规划、改选 Agent，或在确需新权限时询问用户。",
            ]),
          ] : []),
        ].join("\n")
      }

      const request = {
        model: routing.model,
        system: systemPrompt,
        messages,
        tools: finalizationOnly || skipTools ? [] : activeToolSchemas,
        toolChoice: requireNativeTool
          ? "required" as const
          : "auto" as const,
        maxSteps: finalizationOnly ? 1 : Math.max(1, execution.currentLimit() - step),
        thinkingEnabled: input.effort !== "off",  // "off" → 禁用思考
        signal: input.abortSignal,
      }

      // 收集本轮 tool-calls + 文本 + 推理内容
      const pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
      let assistantText = ""
      let publicText = ""
      let reasoningContent = ""
      let reasoningDetails: Array<Record<string, unknown>> | undefined

      // ── LLM 调用（重试 + Fallback）──
      // 构建备用链时过滤掉缺少必要能力的模型（如 coding agent 不应 fallback 到 chat-only 模型）
      const allModels = this.modelRouter.list ?? [routing.model]
      const configuredFallbacks = (input.fallbackModelIds ?? [])
        .map((id) => this.modelRouter.getModel(id))
        .filter((model): model is NonNullable<typeof model> => Boolean(model))
      const protocolExecutors = requireNativeTool
        ? (input.protocolExecutorModelIds ?? [])
            .map((id) => this.modelRouter.getModel(id))
            .filter((model): model is NonNullable<typeof model> =>
              Boolean(model
                && modelProtocolIdentity(model) !== modelProtocolIdentity(routing.model)))
        : []
      const protocolExecutorIdentities = new Set(
        protocolExecutors.map((model) => modelProtocolIdentity(model)),
      )
      const baseCandidateChain = input.modelFallbackEnabled === false
        ? [routing.model, ...protocolExecutors]
        : configuredFallbacks.length > 0
          ? prioritizeFallbackDomains(routing.model, [...configuredFallbacks, ...protocolExecutors])
          : llmManager.buildFallbackChain(routing.model, [...protocolExecutors, ...allModels])
      const feedback = execution.snapshot()
      const feedbackPressure = finalizationOnly ? 0 : feedback.consecutiveNoProgress
      const candidateChain = orderCandidateChainForFeedback(
        baseCandidateChain,
        feedbackPressure,
        Boolean(input.preferredModelId),
      )
      const requiredCapabilities = input.requiredCapabilities ?? agent.requiredCapabilities
      let fallbackChain = candidateChain.filter(m =>
        m.id === routing.model.id  // 路由主模型始终保留（有图片时 vision 模型可能只有 vision 标签）
        || requiredCapabilities.every(cap => m.capabilities.includes(cap as any)))
      // 确保至少有主模型（即使能力不完全匹配，也比没有模型可用好）
      if (fallbackChain.length === 0) fallbackChain.push(routing.model)
      // Without an internal executor, retry the hard-bound conversation model
      // once using the portable `required` form of tool_choice.
      if (requireNativeTool && fallbackChain.length === 1) {
        fallbackChain = [fallbackChain[0]!, fallbackChain[0]!]
      }
      let llmError: string | null = null
      let llmSuccess = false
      let llmFinishReason = ""
      let previousAttemptError: string | undefined
      const failedFaultDomains = new Set<string>()

      // Candidate position and real request count are deliberately independent.
      // Circuit-open candidates do not consume the three real-attempt budget,
      // and are never probed merely because no later candidate is healthy.
      let realAttempts = 0
      for (let candidateIndex = 0; candidateIndex < fallbackChain.length && realAttempts < 3; candidateIndex++) {
        if (input.abortSignal?.aborted) {
          execution.interrupt("用户取消了任务")
          return
        }
        const model = fallbackChain[candidateIndex]
        const internalExecution = protocolExecutorIdentities.has(modelProtocolIdentity(model))
        const protocolObservationScope = [
          input.runId ?? input.sessionId,
          input.executionSegment ?? 0,
          step,
          modelProtocolIdentity(model),
        ].join(":")
        const faultDomain = modelFaultDomain(model)
        const attemptContext = {
          runId: input.runId ?? input.sessionId,
          sessionId: input.sessionId,
          agentId: agent.id,
          scope: "agent" as const,
          operation: input.runType,
          segment: input.executionSegment ?? 0,
          step,
          attempt: candidateIndex + 1,
        }
        if (failedFaultDomains.has(faultDomain)) {
          const reason = `${faultDomain} 在本轮执行中已经发生服务或网络失败`
          llmManager.recordCircuitSkip(attemptContext, model, reason)
          previousAttemptError = reason
          continue
        }
        if (requireRecoveryTool
          && ModelProtocolCapabilityRepo.status(model) === "unsupported") {
          const reason = "该模型最近一次自动协议探测确认不支持原生工具调用"
          llmManager.recordCircuitSkip(attemptContext, model, reason)
          previousAttemptError = reason
          continue
        }
        const availability = llmManager.getModelAvailability(model)
        if (!availability.available) {
          llmManager.recordCircuitSkip(attemptContext, model, availability.reason ?? "模型服务暂时熔断")
          previousAttemptError = availability.reason
          continue
        }
        realAttempts++
        const modelAttempt = llmManager.startModelAttempt(attemptContext, model)
        const routeReason = realAttempts === 1 && candidateIndex === 0
          ? routing.reason
          : `第 ${realAttempts} 次有效尝试：切换到 ${model.name}`
        const announcedModel = `${model.id}:${model.modelId}`
        if (shouldAnnounceModelRoute(announcedModel, lastAnnouncedModel)) {
          yield {
            type: "model-routed",
            modelId: model.modelId.split(",")[0].trim(),
            modelName: model.name,
            attempt: realAttempts,
            fallback: candidateIndex > 0,
            reason: routeReason,
            previousError: previousAttemptError,
            attemptId: modelAttempt.id,
            scope: "agent",
            segment: input.executionSegment ?? 0,
            step,
            internalExecution,
          } as any
          lastAnnouncedModel = announcedModel
        }
        yield {
          type: "model-attempt",
          attemptId: modelAttempt.id,
          scope: "agent",
          operation: input.runType,
          segment: input.executionSegment ?? 0,
          step,
          attempt: realAttempts,
          maxAttempts: 3,
          modelId: model.modelId.split(",")[0].trim(),
          modelName: model.name,
          status: "running",
          _step: step,
        } as any

        // 每次重试前重置本轮状态，防止上次失败残留污染
        pendingToolCalls.length = 0
        assistantText = ""
        publicText = ""
        reasoningContent = ""
        reasoningDetails = undefined
        llmError = null
        llmFinishReason = ""
        let publicOutput = new ModelOutputPolicy()

        // 重建用户消息内容：不同模型对 vision 支持不同，回退时需降级 image_url → 文本
        const modelSupportsVision = model.capabilities?.includes("vision") ?? false
        const retryMessages = modelSupportsVision !== supportsVision
          ? messages.map((m, i) => {
              if (i === messages.length - 1 && m.role === "user") {
                return { ...m, content: buildUserContent(input.userMessage, input.attachments, modelSupportsVision) }
              }
              return m
            })
          : messages
        // 回退到非 vision 模型时，system prompt 也要重建（去掉首轮 skipTools 的图片特化 prompt）
        const retrySkipTools = modelSupportsVision && step === 0 && hasImage
        const retrySystem = (!modelSupportsVision && skipTools)
          ? buildSystemPrompt(agent, input.workingDir, currentScope, input.workflowContext, input.disabledSkills, toolSchemas.map((tool) => tool.name), runtimeTimestamp)
          : request.system

        const retryRequest = {
          ...request,
          model,
          messages: retryMessages,
          system: retrySystem,
          tools: finalizationOnly || retrySkipTools ? [] : activeToolSchemas,
          toolChoice: request.toolChoice,
          usageContext: {
            eventId: `usage:${modelAttempt.id}:0`,
            attemptId: modelAttempt.id,
            runId: input.runId ?? input.sessionId,
            sessionId: input.sessionId,
            agentId: agent.id,
            scope: "agent" as const,
            operation: input.runType,
            segment: input.executionSegment ?? 0,
            step,
          },
        }
        try {
          for await (const event of llmClient.stream(retryRequest)) {
            if (input.abortSignal?.aborted) {
              llmManager.finishModelAttempt(modelAttempt.id, "cancelled", "用户取消了任务")
              execution.interrupt("用户取消了任务")
              return
            }
            if (event.type === "transport-retry") {
              // A failed provider stream is an uncommitted model transaction.
              // Discard its draft state before replaying the same request so
              // partial text/reasoning can never contaminate the next attempt.
              pendingToolCalls.length = 0
              assistantText = ""
              publicText = ""
              reasoningContent = ""
              reasoningDetails = undefined
              llmError = null
              llmFinishReason = ""
              publicOutput = new ModelOutputPolicy()
              logOrchestrationEvent({
                sessionId: input.sessionId,
                runId: input.runId ?? input.sessionId,
                agentId: agent.id,
                eventType: "model.transport-retry",
                level: "warning",
                message: "模型传输中断，正在使用同一模型重新连接",
                data: {
                  attemptId: modelAttempt.id,
                  modelId: model.modelId.split(",")[0].trim(),
                  modelName: model.name,
                  attempt: event.attempt,
                  maxAttempts: event.maxAttempts,
                  retryDelayMs: event.delayMs,
                  failureKind: event.failureKind,
                  reason: event.reason,
                },
              })
              yield {
                type: "model-attempt",
                attemptId: modelAttempt.id,
                scope: "agent",
                operation: input.runType,
                segment: input.executionSegment ?? 0,
                step,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                retryDelayMs: event.delayMs,
                modelId: model.modelId.split(",")[0].trim(),
                modelName: model.name,
                status: "reconnecting",
                failureReason: event.reason,
                _step: step,
              } as any
              continue
            }
            if (event.type === "error") { llmError = event.message; break }
            if (event.type === "text-delta") {
              assistantText += event.text
              const safeText = publicOutput.push(event.text)
              if (safeText) {
                publicText += safeText
                yield { type: "text-delta", text: safeText, _step: step } as any
              }
            }
            if (event.type === "tool-call") {
              observeNativeToolProtocolSuccess(model, protocolObservationScope)
              const normalized = normalizeInboundToolCall(event.name, event.input)
              const toolCall = {
                ...event,
                id: event.id || randomUUID(),
                name: normalized.name,
                input: normalized.input,
              }
              pendingToolCalls.push(toolCall)
              yield { ...toolCall, _step: step }
            }
            if (event.type === "thinking-start") { yield { ...event, _step: step } }
            if (event.type === "thinking-delta") { reasoningContent += event.text; yield { ...event, _step: step } }
            if (event.type === "thinking-end")   { yield { ...event, _step: step } }
            if (event.type === "finish") {
              if (pendingToolCalls.length === 0 && containsTextualToolProtocol(assistantText)) {
                publicOutput.flush()
                publicText = ""
                llmError = "模型将工具调用序列化为文本，未返回原生工具调用事件"
                break
              }
              if (pendingToolCalls.length === 0 && retryRequest.toolChoice !== "auto"
                && retryRequest.tools.length > 0) {
                publicOutput.flush()
                publicText = ""
                llmError = "模型未遵守原生工具调用协议：恢复阶段必须调用任一符合恢复契约的可用工具"
                observeNativeToolProtocolFailure({
                  model,
                  scope: protocolObservationScope,
                  reason: llmError,
                  completedWithoutToolCall: true,
                })
                break
              }
              if (!finalizationOnly && pendingToolCalls.length === 0) {
                const handoffError = detectExecutableManualHandoff({
                  modelText: assistantText,
                  userMessage: input.userMessage,
                  availableToolNames: retryRequest.tools.map((tool) => tool.name),
                })
                if (handoffError) {
                  publicOutput.flush()
                  publicText = ""
                  llmError = handoffError
                  break
                }
              }
              const safeText = publicOutput.flush()
              if (safeText) {
                publicText += safeText
                yield { type: "text-delta", text: safeText, _step: step } as any
              }
              const delivery = validateModelTurnDelivery({
                publicText,
                nativeToolCallCount: pendingToolCalls.length,
              })
              if (!delivery.valid) {
                llmError = delivery.reason
                break
              }
              llmSuccess = true
              llmFinishReason = event.finishReason ?? ""
              // 工具（尤其 task 子 Agent）必须继承本轮真正成功的模型，而不是初始路由模型。
              // An internal protocol executor performs one concrete tool
              // action; it must never replace the composer-selected public
              // conversation identity inherited by later child runs.
              if (!internalExecution) toolCtx.preferredModelId = model.id
              // 从 finish 事件补充捕获 reasoningContent（llm-client 统一在 finish 时返回）
              if (event.reasoningContent) reasoningContent = event.reasoningContent
              if (event.reasoningDetails?.length) reasoningDetails = event.reasoningDetails
              yield { ...event, originModelId: model.id, _step: step } as any
              // 发送上下文容量信息
              if (event.usage) {
                const sysTokens = Math.ceil(request.system.length / 3)
                const msgTokens = messages.reduce((s, m) => s + Math.ceil(JSON.stringify(m.content).length / 3), 0)
                const toolTokens = toolSchemas.reduce((s, t) => s + Math.ceil(JSON.stringify(t).length / 3), 0)
                const totalUsed = event.usage.promptTokens
                const otherTokens = Math.max(0, totalUsed - sysTokens - msgTokens - toolTokens)
                const contextWindow = contextInputBudget(
                  model.contextWindow ?? 128000,
                  model.maxOutputTokens ?? 4096,
                )
                const projectedShape = estimateProjectedHistoryShape(
                  model,
                  retryMessages,
                  input.effort !== "off",
                )
                yield {
                  type: "context-capacity",
                  used: totalUsed,
                  total: contextWindow,
                  breakdown: { messages: msgTokens, systemTools: toolTokens, skills: 0, systemPrompt: sysTokens, other: otherTokens },
                  protocolMessages: { used: projectedShape.messages + 1, total: PROTOCOL_MESSAGE_LIMIT },
                  usage: event.usage,
                  source: "model",
                  estimated: false,
                  _step: step,
                } as any
              }
            }
          }
          // 只在真正成功（finish 事件）时跳出重试循环
          // 流式中途出错但已产出部分文本时不视为成功，继续尝试 fallback
          if (llmSuccess) {
            llmManager.finishModelAttempt(modelAttempt.id, "succeeded")
            yield {
              type: "model-attempt",
              attemptId: modelAttempt.id,
              scope: "agent",
              operation: input.runType,
              segment: input.executionSegment ?? 0,
              step,
              attempt: realAttempts,
              maxAttempts: 3,
              modelId: model.modelId.split(",")[0].trim(),
              modelName: model.name,
              status: "succeeded",
              _step: step,
            } as any
            break
          }
        } catch (err: any) {
          llmError = err.message
        }
        previousAttemptError = llmError ?? "模型未返回完成事件"
        if (requireNativeTool && llmError) {
          observeNativeToolProtocolFailure({
            model,
            scope: protocolObservationScope,
            reason: llmError,
          })
        }
        llmManager.finishModelAttempt(modelAttempt.id, "failed", previousAttemptError)
        yield {
          type: "model-attempt",
          attemptId: modelAttempt.id,
          scope: "agent",
          operation: input.runType,
          segment: input.executionSegment ?? 0,
          step,
          attempt: realAttempts,
          maxAttempts: 3,
          modelId: model.modelId.split(",")[0].trim(),
          modelName: model.name,
          status: "failed",
          failureReason: previousAttemptError,
          _step: step,
        } as any
        if (isFaultDomainFailure(previousAttemptError)) failedFaultDomains.add(faultDomain)
        // Empty output is a protocol failure distinct from provider/model
        // fallback. When one model is hard-bound, schedule exactly one retry of
        // that same model and keep every other failure policy unchanged.
        if (previousAttemptError === EMPTY_MODEL_TURN_ERROR
          && fallbackChain.length === 1
          && realAttempts === 1) {
          fallbackChain.push(model)
        }
        // 静默切换，不暴露给用户
      }

      // 所有 fallback 都失败 → 报错退出
      if (!llmSuccess) {
        if (finalizationOnly) {
          const delivery = finalDeliveryPolicy.resolve({
            snapshot: execution.snapshot(),
            modelText: redactInternalImplementationDetails(assistantText),
            modelError: llmError ?? previousAttemptError,
          })
          logOrchestrationEvent({
            sessionId: input.sessionId,
            runId: input.runId ?? input.sessionId,
            parentRunId: input.parentRunId,
            agentId: agent.id,
            eventType: "final-delivery.fallback",
            level: "warning",
            message: "最终总结模型轮次不可用，已使用运行时证据生成交付内容",
            data: {
              source: delivery.source,
              executionState: execution.snapshot().state,
              runtimeObjectiveAccepted: execution.snapshot().runtimeObjectiveAccepted,
              diagnostic: delivery.diagnostic,
            },
          })
          for (const event of finalDeliveryEvents(delivery, step)) yield event
          break
        }
        if (!finalizationOnly && llmError?.includes("未返回原生工具调用事件") && protocolRepairAttempts < 3) {
          protocolRepairAttempts++
          messages.push({
            role: "user",
            content: "上一轮返回了不可执行的文本工具标记，运行时已丢弃。请通过当前 API 的原生工具调用通道继续当前任务；不要在正文中书写 DSML、tool_calls、invoke 或 parameter 标签。",
          })
          yield {
            type: "agent-progress",
            phase: "repair",
            step: step + 1,
            maxSteps: execution.currentLimit(),
            _step: step,
          } as any
          continue
        }
        if (!finalizationOnly && llmError === EXECUTABLE_MANUAL_HANDOFF_ERROR
          && manualHandoffRepairAttempts < 2) {
          manualHandoffRepairAttempts++
          messages.push({
            role: "user",
            content: "上一轮把当前可执行命令转交给了用户，运行时已丢弃该草稿。Bash 工具当前真实可用；请立即通过原生 bash 工具调用继续同一任务。权限为询问时运行时会自动显示审批并在批准后恢复，禁止再次输出命令让用户复制运行。",
          })
          yield {
            type: "agent-progress",
            phase: "repair",
            step: step + 1,
            maxSteps: execution.currentLimit(),
            _step: step,
          } as any
          continue
        }
        const resolvedError = llmError ?? previousAttemptError ?? "当前没有可用的候选模型"
        const publicError = summarizeModelFailure(resolvedError) ?? "模型调用失败"
        if (isModelExternalBlocker(resolvedError)) {
          execution.markBlocked(publicError)
          yield {
            type: "execution-blocked",
            reason: publicError,
            _step: step,
          } as any
          return
        }
        execution.fail(publicError)
        yield { type: "error", message: publicError, _step: step }
        return
      }

      const turnDecision = turnLoopPolicy.decide({
        nativeToolCallCount: pendingToolCalls.length,
        finishReason: llmFinishReason,
      })
      if (pendingToolCalls.length === 0) {
        const lateGuidance = applyPendingGuidance()
        if (lateGuidance.length > 0) {
          if (assistantText) messages.push({ role: "assistant", content: assistantText })
          for (const guidance of lateGuidance) {
            yield {
              type: "guidance-applied",
              requestId: guidance.requestId,
              message: guidance.message,
              _step: step,
            } as any
          }
          continue
        }
      }
      if (turnDecision.type === "continue-output" && outputContinuationSegments < 4) {
        outputContinuationSegments++
        messages.push({ role: "assistant", content: assistantText })
        messages.push({
          role: "user",
          content: "上一段因模型输出长度上限中止。请从中止位置继续完成当前回答，不要重复已经输出的段落。",
        })
        continue
      }

      if (turnDecision.type === "complete") {
        const yieldDecision = execution.onModelYield()
        if (yieldDecision === "blocked") {
          yield { type: "execution-blocked", reason: execution.snapshot().stopReason, _step: step } as any
          break
        }
        if (yieldDecision === "finalize" && !finalizationOnly) continue
        break
      }
      if (finalizationOnly) {
        const delivery = finalDeliveryPolicy.resolve({
          snapshot: execution.snapshot(),
          modelText: redactInternalImplementationDetails(publicText || assistantText),
          modelError: "最终总结阶段返回了不允许执行的工具调用",
        })
        logOrchestrationEvent({
          sessionId: input.sessionId,
          runId: input.runId ?? input.sessionId,
          parentRunId: input.parentRunId,
          agentId: agent.id,
          eventType: "final-delivery.fallback",
          level: "warning",
          message: "最终总结模型轮次返回工具调用，已忽略并使用运行时证据生成交付内容",
          data: {
            source: delivery.source,
            executionState: execution.snapshot().state,
            runtimeObjectiveAccepted: execution.snapshot().runtimeObjectiveAccepted,
            diagnostic: delivery.diagnostic,
          },
        })
        for (const event of finalDeliveryEvents(delivery, step)) yield event
        break
      }
      yield { type: "agent-progress", phase: "tools", step: step + 1, maxSteps: execution.currentLimit(), toolCount: pendingToolCalls.length, _step: step } as any

      const progressRevisionBefore = execution.snapshot().progressRevision ?? 0
      const toolBatchIterator = executeToolBatch({
        input,
        agent: authorityAgent,
        step,
        pendingToolCalls,
        messages,
        toolCtx,
        permissionContextId,
        initialScope,
        resolveVisibleTools,
        visibleToolNames,
        execution,
        executionDeadline,
        toolRegistry: this.toolRegistry,
        agentRegistry: this.agentRegistry,
        pendingStreams,
        pendingActivities,
        pendingNestedEvents,
        notifyStreamSettled: () => {
          wakeStream?.()
          wakeStream = null
        },
        waitForStream,
      })
      let toolBatch: import("./agent-loop-tool-execution.ts").ToolExecutionBatch | undefined
      while (true) {
        const next = await toolBatchIterator.next()
        if (next.done) {
          toolBatch = next.value
          break
        }
        yield next.value
      }
      if (!toolBatch || toolBatch.interrupted) return
      executionDeadline = toolBatch.executionDeadline
      const { toolResults, executionOutcomes, dispatchInstruction } = toolBatch

      // 将 tool-calls + results 回填到消息
      // DeepSeek 要求：带 tool_calls 的 assistant 消息必须携带 reasoning_content
      messages.push({
        role: "assistant",
        content: assistantText || "",
        toolCalls: pendingToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
        reasoningContent: reasoningContent || undefined,
        reasoningDetails,
        originModelId: toolCtx.preferredModelId,
      })
      const toolObservationDecision = execution.observe(executionOutcomes, { progressRevisionBefore })
      const observedSnapshot = execution.snapshot()
      if ((observedSnapshot.progressRevision ?? 0) === progressRevisionBefore) {
        logOrchestrationEvent({
          sessionId: input.sessionId,
          runId: input.runId ?? input.sessionId,
          parentRunId: input.parentRunId,
          agentId: agent.id,
          eventType: "execution.no-progress",
          level: toolObservationDecision.stopReason === "stalled" ? "error" : "warning",
          message: toolObservationDecision.stopReason === "stalled"
            ? "重复工具结果未改变目标状态，运行已按停滞策略收敛"
            : "本轮工具结果未形成新的目标进展",
          data: {
            segment: observedSnapshot.segment,
            toolRound: observedSnapshot.toolRounds,
            limit: observedSnapshot.limit,
            consecutiveNoProgress: observedSnapshot.consecutiveNoProgress,
            progressRevision: observedSnapshot.progressRevision ?? 0,
            tools: executionOutcomes.map((outcome) => outcome.name),
            stopReason: toolObservationDecision.stopReason,
          },
        })
      }

      // 本轮工具均已返回，不能再把它们作为“待执行”恢复。
      checkpointManager.clear(input.checkpointKey ?? input.sessionId)

      // 先回填 tool 结果：OpenAI/DeepSeek 要求 role=tool 消息紧跟
      // 带有 tool_calls 的 assistant 消息，中间不能插入 user 消息（否则 HTTP 400）
      // 大结果使用结构化头尾信封，避免破坏 JSON 并保留末尾诊断。
      messages.push({
        role: "tool",
        content: "",
        toolResults: toolResults.map(tr => ({
          id: tr.id, name: tr.name,
          result: formatToolResultForContext(tr.result, tr.executionId, 8_000, tr.name),
        })),
      })
      if (dispatchInstruction) messages.push({ role: "user", content: dispatchInstruction })
      const evidenceRecovery = buildActiveRecoveryInstruction(execution.currentRecovery())
        || buildEvidenceRecoveryInstruction(executionOutcomes)
      if (evidenceRecovery) messages.push({ role: "user", content: evidenceRecovery })

      // SelfCritic：编译失败时启动自动修复循环
      for (const tc of pendingToolCalls) {
        if (tc.name === "compile") {
          const tr = toolResults.find(r => r.id === tc.id)
          const compileErrors = extractCompileErrors(tr?.result)
          if (compileErrors && compileErrors.length > 0) {
            yield { type: "agent-progress", phase: "repair", step: step + 1, maxSteps: execution.currentLimit(), _step: step } as any
            const suggestions = generateFixSuggestions(compileErrors)
            const reflectionPrompt = buildReflectionPrompt(
              compileErrors.map((e: any) => `${e.file}:${e.line}: ${e.message}`),
              suggestions,
            )
            messages.push({ role: "user", content: reflectionPrompt })
          }
        }
        // plan 成功提交后结束当前规划阶段；运行时决定等待审批或切换执行阶段。
        if (tc.name === "plan" && !(toolResults.find((result) => result.id === tc.id)?.result as any)?.error) {
          checkpointManager.clear(input.sessionId)
          yield { type: "plan-submitted" }
          return
        }
      }
    }
    checkpointManager.clear(input.sessionId)
  }

  /**
   * 构建系统提示词
   */

}

export type { RuntimeTodo }
