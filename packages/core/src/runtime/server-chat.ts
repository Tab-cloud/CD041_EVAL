import type { ExecutionOutstandingSummary, ExecutionSnapshot } from "./agent-loop-control"
import { llmManager, summarizeModelFailure } from "./llm-manager"
import { ragEngine } from "./rag"
import { taskScheduler } from "./task-scheduler"
import { MessageRepo, SessionRepo } from "../store/repository"
import { json } from "./server-response"
import { redactSensitiveData, redactSensitiveRecord } from "./sensitive-data"
import { ToolExecutionRepo } from "../store/tool-execution"
import { prepareConversationContext, resolveContextModel } from "./server-context.ts"
import { attachSerialDebugContext, normalizeSerialDebugContext } from "./serial-context.ts"
import {
  buildPlannedExecutionMessage,
  resolveExecutionPhaseContract,
} from "./execution-flow.ts"
import {
  compileExecutablePlan,
  type ExecutablePlan,
} from "./executable-plan.ts"
import type { PlanContract } from "./plan-contract.ts"
import { runtimeAccessManager } from "./runtime-access.ts"
import { ExecutionRunRepo } from "../store/execution-run.ts"
import { TaskRunRepo } from "../store/task-run.ts"
import { classifyExecutionTerminal, publicExecutionStopReason } from "./execution-terminal.ts"
import { logOrchestrationEvent } from "./orchestration-log.ts"
import { MainAgentMessageAccumulator } from "./main-agent-message.ts"
import {
  conversationObjectiveFingerprint,
  executionMatchesConversationObjective,
  resolveContinuationObjectiveMessage,
  resolveConversationObjectiveProposal,
  type ResolvedConversationObjective,
} from "./conversation-objective.ts"
import { ConversationObjectiveRepo } from "../store/conversation-objective.ts"
import { SessionCommandRepo } from "../store/session-command.ts"
import { RunGuidanceRepo } from "../store/run-guidance.ts"
import { brokerSubAgentInteraction } from "./main-agent-interaction-routing.ts"
import {
  fallbackConversationTurnIntent,
  resolveConversationTurnIntent,
  type ConversationTurnIntent,
} from "./conversation-turn-intent.ts"
import {
  buildMainAgentCoordinationContext,
  createTaskStatusPublisher,
  isInternalOrchestrationTool,
  publicApproval,
  publicExecutionState,
  publicQuestion,
  publicToolRecords,
  renderExecutionStatus,
  settleExecutionSnapshot,
  taskView,
} from "./server-chat-projections.ts"
import {
  resolveConversationModelFallback,
  resolveProtocolExecutorModelIds,
} from "./server-chat-policy.ts"
import {
  persistSchematicConversationSummaries,
  resolveCompletedExecutionLineage,
} from "./server-chat-artifacts.ts"
import { createRunEventEmitter } from "./server-chat-events.ts"
import { finalizeDeliveredFiles, type DeliveredFile } from "./delivered-files.ts"
import { projectPublicProblem } from "./public-run-event.ts"
import { PublicAgentEventForwarder } from "./server-chat-public-events.ts"
import {
  acquireChatCommand,
  prepareChatRequest,
  type ChatDependencies,
} from "./server-chat-request.ts"
import { prepareSessionTurn } from "./server-chat-session.ts"
import { resolveContinuationResources } from "./server-chat-continuation.ts"
import { resolveRootAgentRouting } from "./server-chat-semantic-routing.ts"
import {
  admitChatRoot,
  asRootAdmissionPhaseError,
  failAdmittedChatRoot,
  RootAdmissionPhaseError,
  type AdmittedChatRoot,
} from "./server-chat-root-admission.ts"

export { buildExecutionStatusContext, buildMainAgentCoordinationContext, createTaskStatusPublisher, isInternalOrchestrationTool, publicApproval, publicQuestion, publicToolRecords, renderExecutionStatus, settleExecutionSnapshot } from "./server-chat-projections.ts"
export { resolveCommandAgent, resolveConversationModelFallback, resolveProtocolExecutorModelIds, shouldAutoPlan } from "./server-chat-policy.ts"
export { isDurableRunEvent } from "./server-chat-events.ts"
export type { ChatDependencies } from "./server-chat-request.ts"

const SSE_HEARTBEAT_MS = 8_000

export async function handleChat(req: Request, corsHeaders: Record<string, string>, deps: ChatDependencies): Promise<Response> {
  const {
    agentLoop,
    agentRegistry,
    toolRegistry,
    modelRouter,
    orchestrator,
    conversationTurnResolver,
    semanticTaskAnalyzer,
  } = deps
  const prepared = await prepareChatRequest(await req.json().catch(() => ({})), {
    modelRouter,
    agentRegistry,
    systemReady: Boolean(agentRegistry && toolRegistry && orchestrator && agentLoop),
  })
  if (!prepared.ok) {
    return json({ error: prepared.error }, { ...corsHeaders, status: prepared.status })
  }
  if (!agentRegistry || !toolRegistry || !orchestrator || !agentLoop) {
    return json({ error: "Agent 系统未初始化" }, { ...corsHeaders, status: 503 })
  }
  const {
    body,
    message,
    sessionId,
    requestId,
    resumeTaskId,
    explicitResumeTask,
    workingDir,
    systemSettings,
    effort,
    requestedScope,
    requestedModelId,
    intentModelId,
    commandAgentId,
    requestedAgentId,
    processedAttachments,
  } = prepared.value

  const commandAdmission = await acquireChatCommand({ req, corsHeaders, prepared: prepared.value })
  if ("response" in commandAdmission) return commandAdmission.response
  const { commandOwner } = commandAdmission

  let admittedRoot: AdmittedChatRoot
  try {
    admittedRoot = admitChatRoot({
      requestId,
      commandOwner,
      sessionId,
      message,
      workingDir,
      scope: requestedScope,
      effort,
      modelId: requestedModelId,
      retryOf: resumeTaskId,
    })
    // Interpretation is execution work owned by the root, so it begins only
    // after that root has acquired the unified scheduler lane and resources.
    await taskScheduler.waitForTurn(admittedRoot.task.id, admittedRoot.abortController.signal)
  } catch (error) {
    const failure = asRootAdmissionPhaseError(
      error,
      "admission",
      "主 Agent 根任务未能取得执行所有权",
      "root-admission-failed",
    )
    const problem = projectPublicProblem(failure.message)
    return json({
      error: problem.message,
      problem,
      requestId,
      diagnostic: {
        kind: failure.kind,
        stage: failure.stage,
        diagnosticId: problem.diagnosticId,
        nextActions: ["检查统一调度与命令绑定状态后重新提交当前命令"],
      },
    }, { ...corsHeaders, status: failure.httpStatus })
  }
  const task = admittedRoot.task
  const runAbort = admittedRoot.abortController

  try {
  // This is intentionally after durable FIFO acquisition. The preceding
  // command has now reached a terminal state, so history and intent are based
  // on the latest assistant delivery rather than the HTTP arrival snapshot.
  const existingSession = SessionRepo.get(sessionId)
  const priorMessageRows = MessageRepo.getBySession(sessionId)
  let durableProposals = existingSession
    ? ConversationObjectiveRepo.openBySession(sessionId)
    : []
  const latestResumable = ExecutionRunRepo.latestResumableBySession(sessionId)
  const latestRelevant = ExecutionRunRepo.latestRelevantBySession(sessionId)
  const recentAssistantMessages = [...priorMessageRows].reverse()
    .filter((row) => row.role === "assistant" && row.content.trim())
    .slice(0, 8)
    .map((row) => ({ id: row.id, content: row.content }))
  let turnIntent: ConversationTurnIntent
  try {
    turnIntent = resumeTaskId
      ? {
          kind: "resume-objective",
          confidence: 1,
          taskId: resumeTaskId,
          continuationMode: "control-only",
        }
      : await (conversationTurnResolver ?? resolveConversationTurnIntent)({
          message,
          recentAssistantMessages,
          openObjectives: durableProposals,
          latestResumable,
          latestRelevant,
          modelRouter,
          preferredModelId: intentModelId,
          sessionId,
          rootRunId: task.id,
          abortSignal: runAbort.signal,
        })
  } catch (error) {
    if (runAbort.signal.aborted) throw error
    turnIntent = fallbackConversationTurnIntent(error)
  }
  if (turnIntent.fallbackReason) {
    logOrchestrationEvent({
      sessionId,
      runId: task.id,
      agentId: "main-agent",
      eventType: "conversation-intent.degraded",
      level: "warning",
      message: "会话意图建议无法绑定到真实运行状态，已按普通新回合继续",
      data: {
        reason: turnIntent.fallbackReason,
        recoveredKind: turnIntent.kind,
      },
    })
  }
  const inferredProposal = turnIntent.proposal && existingSession
    ? ConversationObjectiveRepo.propose(sessionId, turnIntent.proposal)
    : null
  if (inferredProposal) durableProposals = ConversationObjectiveRepo.openBySession(sessionId)
  const selectedObjective = turnIntent.objectiveId
    ? durableProposals.find((objective) => objective.id === turnIntent.objectiveId)
    : inferredProposal ?? undefined
  const resumeCandidate = resumeTaskId
    ? ExecutionRunRepo.get(resumeTaskId)
    : turnIntent.taskId
      ? ExecutionRunRepo.get(turnIntent.taskId)
      : selectedObjective?.activeRunId
        ? ExecutionRunRepo.get(selectedObjective.activeRunId)
        : null
  // A durable objective and its execution graph are one versioned aggregate.
  // Never resume a graph merely because its run id is attached to the same
  // objective row: the objective may have been reclassified or normalized
  // since that graph was created.
  const resumeSource = selectedObjective && resumeCandidate
    ? executionMatchesConversationObjective(resumeCandidate.snapshot, selectedObjective)
      ? resumeCandidate
      : null
    : resumeCandidate
  const statusQuery = turnIntent.kind === "status-query"
  if (resumeSource) {
    TaskRunRepo.bindRetryOf(task.id, resumeSource.taskId)
    task.retryOf = resumeSource.taskId
  }
  const continuationResources = await resolveContinuationResources({
    currentAttachments: processedAttachments,
    currentRequestId: requestId,
    sessionId,
    workingDir,
    resumeTaskId: resumeSource?.taskId,
    snapshot: resumeSource?.snapshot,
  })
  const effectiveAttachments = continuationResources.attachments
  const resumeTask = resumeSource ? TaskRunRepo.get(resumeSource.taskId) : null
  const proposalObjective = selectedObjective
    ? resolveConversationObjectiveProposal(selectedObjective, selectedObjective.taskCount)
    : null
  const resolvedObjective: ResolvedConversationObjective = turnIntent.kind === "resume-objective"
    ? {
        ...proposalObjective,
        effectiveMessage: resolveContinuationObjectiveMessage({
          currentMessage: message,
          continuationMode: turnIntent.continuationMode ?? "control-only",
          resumedObjective: proposalObjective?.effectiveMessage
            ?? resumeSource?.snapshot.runtimeObjectiveContent,
          resumeTaskMessage: resumeTask?.message,
          resourceSourceMessage: continuationResources.sourceMessage,
          continuationContractVersion: proposalObjective
            ? 2
            : resumeSource?.snapshot.continuationContractVersion,
        }),
        confirmation: true,
      }
    : proposalObjective
      ? proposalObjective
      : { effectiveMessage: message, confirmation: false }
  const objectiveMessage = resolvedObjective.effectiveMessage
  const planContinuation = turnIntent.kind === "resume-plan"
  const configuredAgentId = systemSettings.preferredAgentId && agentRegistry?.get(systemSettings.preferredAgentId)
    ? systemSettings.preferredAgentId : undefined
  const resumeAgentId = explicitResumeTask?.agentId ?? (resumeSource ? TaskRunRepo.get(resumeSource.taskId)?.agentId : undefined)
  const continuedAgentId = resumeAgentId && agentRegistry?.get(resumeAgentId)
    ? resumeAgentId
    : planContinuation && existingSession && agentRegistry?.get(existingSession.agent_id)
      ? existingSession.agent_id : undefined
  let routing: Awaited<ReturnType<typeof resolveRootAgentRouting>>
  try {
    routing = await resolveRootAgentRouting({
      message: objectiveMessage,
      resources: effectiveAttachments.map(({ name, mime, kind }) => ({ name, mime, kind })),
      scope: requestedScope,
      sessionId,
      requestId,
      rootRunId: task.id,
      workingDir,
      preferredModelId: intentModelId,
      modelRouter,
      agentRegistry,
      toolRegistry,
      orchestrator,
      systemSettings,
      turnKind: turnIntent.kind,
      mayAutoPlan: !resumeSource && !resolvedObjective.confirmation && !statusQuery,
      planContinuation,
      commandAgentId,
      requestedAgentId,
      continuedAgentId,
      configuredAgentId,
      signal: runAbort.signal,
      semanticTaskAnalyzer,
    })
  } catch (error) {
    throw asRootAdmissionPhaseError(
      error,
      "semantic-routing",
      "无法建立可验证的结构化任务协议",
      "semantic-task-analysis-failed",
    )
  }
  const { semanticAnalysis, autoPlanning, executionFlow, selectedAgent } = routing
  runtimeAccessManager.begin(sessionId, executionFlow.scope)
  const agentId = selectedAgent.agent.id
  if (agentId !== task.agentId) {
    throw new RootAdmissionPhaseError(
      "semantic-routing",
      "root-owner-identity-changed",
      "主 Agent 根任务身份校验失败",
      `语义路由试图把根 owner 从 ${task.agentId} 改为 ${agentId}`,
      500,
      task.id,
    )
  }
  const agentName = selectedAgent.agent.name
  const executionAgentId = selectedAgent.executionAgent.id
  const executionAgentName = selectedAgent.executionAgent.name
  const ownerRoute = systemSettings.agentModelRoutes[agentId]
  const executionAgentRoute = systemSettings.agentModelRoutes[executionAgentId]
  const agentRoute = executionAgentRoute ?? ownerRoute
  const preferredModelId = requestedModelId
    ?? (agentRoute?.primaryModelId && modelRouter?.getModel(agentRoute.primaryModelId) ? agentRoute.primaryModelId : undefined)
    ?? (systemSettings.defaultModelId && modelRouter?.getModel(systemSettings.defaultModelId) ? systemSettings.defaultModelId : undefined)
  const modelFallbackEnabled = resolveConversationModelFallback(requestedModelId, systemSettings.modelFallbackEnabled)
  const protocolExecutorModelIds = resolveProtocolExecutorModelIds(
    modelRouter,
    preferredModelId,
    selectedAgent.executionAgent.requiredCapabilities,
    systemSettings.agentModelRoutes[executionAgentId],
  )
  const serialContext = normalizeSerialDebugContext(body.serialContext)
  const modelMessage = attachSerialDebugContext(objectiveMessage, serialContext)

  if (!agentRegistry.get(agentId)) {
    throw new RootAdmissionPhaseError(
      "semantic-routing",
      "root-agent-unavailable",
      "当前执行角色不可用",
      "当前执行角色不可用",
      400,
      task.id,
    )
  }

  // 先取历史（尚未包含本次用户消息），再保存用户消息——避免重复。
  // 自动压缩会在任务获得调度权后执行，避免排队期间占用摘要模型。
  let { session, history, resumedExecution } = prepareSessionTurn({
    existingSession,
    sessionId,
    requestId,
    message,
    agentId,
    workingDir,
    requestedModelId,
    effort,
    requestedScope,
    priorMessageRows,
    resumeSnapshot: resumeSource?.snapshot,
  })

  const conversationObjective = resolvedObjective.sourceMessageId
    ? ConversationObjectiveRepo.activate(sessionId, resolvedObjective.sourceMessageId, task.id)
    : null
  logOrchestrationEvent({
    sessionId,
    runId: task.id,
    agentId,
    eventType: "root.selected",
    message: "主 Agent 根任务已完成语义路由和执行角色选择",
    data: {
      agentName,
      mainAgentInstanceId: session.main_agent_instance_id,
      executionAgentId,
      executionAgentName,
      requestedAgentId,
      selectionSource: selectedAgent.source,
      internallyReassigned: selectedAgent.internallyReassigned,
      semanticSource: semanticAnalysis.source,
      semanticFallbackReason: semanticAnalysis.fallbackReason,
      requiredEffects: selectedAgent.requiredEffects,
      objective: selectedAgent.objective,
      requestedScope,
      executionScope: executionFlow.executionScope,
      autoPlanning,
      planContinuation,
      confirmationSourceMessageId: resolvedObjective.sourceMessageId,
      conversationObjectiveId: conversationObjective?.id,
      referencedTaskCount: resolvedObjective.referencedTaskCount,
      rawMessage: resolvedObjective.confirmation ? message : undefined,
      requestId,
    },
  })

  let sseAborted = false
  const requestToolCallIds = new Set<string>()
  const stream = new ReadableStream({
    async start(controller) {
      const emit = createRunEventEmitter({
        controller,
        runId: task.id,
        sessionId,
        requestId,
        agentId,
        isSseAborted: () => sseAborted,
      })
      const publishTaskStatus = createTaskStatusPublisher(
        (view: NonNullable<ReturnType<typeof taskView>>) => emit("task-status", view),
      )
      const emitTaskStatus = () => {
        const view = taskView(task)
        return view ? publishTaskStatus(view) : false
      }
      let cancellationCaught = false
      // 某些模型会在生成完整工具参数前保持静默。WebView/代理可能把这种空闲 SSE
      // 误判为断线，因此在后台任务运行期间持续发送轻量心跳。
      const heartbeat = setInterval(() => emit("heartbeat", { timestamp: Date.now() }), SSE_HEARTBEAT_MS)

      const startTime = Date.now()
      // The root starts with one renewable execution window. Delegated
      // children receive bounded leases from the currently active window.
      const executionDeadline = startTime + systemSettings.executionBudget.rootWindowMs
      const messageAccumulator = new MainAgentMessageAccumulator()
      const publicAgentEvents = new PublicAgentEventForwarder(effort !== "off")
      let hasError = false
      let agentError = ""
      // 实际路由到的模型（由 agent-loop 的 model-routed 事件回填，默认回退到 agentId）
      let routedModelId = agentId
      let routedModelName = agentName
      let routeReason = ""
      const routeAttempts: Array<{
        modelId: string
        modelName: string
        attempt: number
        fallback: boolean
        reason: string
        previousError?: string
        attemptId?: string
        scope?: "agent" | "tool"
        segment?: number
        step?: number
      }> = []
      let lastPublicRouteSignature = ""
      // 收集本轮工具调用/结果，用于持久化到 DB（多轮对话历史需要）
      const collectedToolCalls: any[] = []
      const collectedToolResults: any[] = []
      let executionSnapshot: ExecutionSnapshot | undefined = resumedExecution

      // AgentChain 工作流上下文（由 orchestrator 检测预定义工作流）
      const contextParts = [
        orchestrator?.getWorkflowContext(semanticAnalysis) ?? "",
        autoPlanning ? "## 自动规划\n该请求包含多个阶段。先提交结构化计划；提交成功后运行时会自动恢复用户原先选择的执行范围并继续，不要在规划阶段修改文件。" : "",
        planContinuation ? "## 执行已批准计划\n沿用会话中已批准的计划执行。计划包含其他专业角色时，必须通过 task 工具委派给对应 Agent，并汇总每个节点的真实结果。" : "",
        resolvedObjective.confirmation
          ? "## 已确认执行\n用户已确认上一条主 Agent 提出的工作。直接执行并验证其中的待办，不要再次请求确认。"
          : "",
      ]

      try {
        emitTaskStatus()
        await taskScheduler.waitForTurn(task.id, runAbort.signal)
        emitTaskStatus()
        emit("session", { sessionId, taskId: task.id })
        if (statusQuery) {
          // Status is a control-plane projection, not a generative task. Read
          // it after acquiring the lane so a preceding run has reached its
          // authoritative terminal state, then publish without creating a new
          // execution snapshot that could shadow the task being inspected.
          const statusSource = ExecutionRunRepo.latestRelevantBySession(sessionId)
          const delivery = renderExecutionStatus(
            statusSource?.snapshot,
            statusSource ? TaskRunRepo.get(statusSource.taskId) : null,
          )
          MessageRepo.create({
            session_id: sessionId,
            request_id: requestId,
            role: "assistant",
            content: delivery,
            agent_id: agentId,
            tool_calls: null,
            tool_results: null,
            seq: MessageRepo.latestSeq(sessionId) + 1,
            timestamp: Date.now(),
          })
          const partId = `text:${task.id}:compact`
          emit("assistant-part", { partId, partType: "text", status: "start", timestamp: Date.now() })
          emit("assistant-part", { partId, partType: "text", status: "delta", text: delivery, timestamp: Date.now() })
          emit("assistant-part", { partId, partType: "text", status: "end", outcome: "completed", timestamp: Date.now() })
          taskScheduler.completeTask(task.id, delivery)
          emitTaskStatus()
          emit("done", { sessionId, taskId: task.id, status: task.status, result: delivery })
          return
        }
        if (serialContext) emit("serial-context", { port: serialContext.port, baudRate: serialContext.baudRate, lineCount: serialContext.lines.length })
        const contextModel = resolveContextModel({
          modelRouter,
          preferredModelId,
          requiredCapabilities: [...selectedAgent.executionAgent.requiredCapabilities],
          hasImage: effectiveAttachments.some((attachment) => attachment.kind === "image"),
        })
        const preparedContext = await prepareConversationContext({
          session,
          rows: priorMessageRows,
          incomingMessage: modelMessage,
          attachments: effectiveAttachments,
          model: contextModel,
          emit: (event) => {
            emit("context-compaction", event)
            emit("context-capacity", {
              used: event.used,
              total: event.total,
              breakdown: {
                messages: event.breakdown.messages,
                systemTools: 0,
                skills: 0,
                systemPrompt: 0,
                other: event.breakdown.attachments + event.breakdown.overhead,
              },
              protocolMessages: event.protocolMessages,
              limitingFactor: event.limitingFactor,
              source: "preflight-estimate",
              estimated: true,
            })
          },
        })
        history = preparedContext.history
        if (systemSettings.workspaceIndexing) {
          try {
            await ragEngine.ensureIndexed(workingDir)
            contextParts.push(ragEngine.buildRAGContext(objectiveMessage, workingDir))
          } catch { /* 工作区不可索引时不阻塞聊天 */ }
        }
        const workflowCtx = contextParts.filter(Boolean).join("\n\n")
        const coordinationCtx = buildMainAgentCoordinationContext({
          executionAgentId,
          executionAgentName,
          source: selectedAgent.source,
          requiredEffects: selectedAgent.requiredEffects,
          goalType: selectedAgent.objective.goalType,
          turnKind: turnIntent.kind,
          command: typeof body.command === "string" ? body.command : undefined,
        })
        let runScope = executionFlow.scope
        let runMessage = modelMessage
        let runWorkflowContext = [workflowCtx, coordinationCtx].filter(Boolean).join("\n\n") || undefined
        let submittedPlan: {
          title?: unknown
          content?: unknown
          contract?: PlanContract
        } | null = null
        let activePlan: ExecutablePlan | undefined
        let planSubmitted = false
        let mayContinueAfterPlan = executionFlow.continueAfterPlan
        let executionStop: {
          reason: string
          outstandingTodos: number
          outstandingSummary?: ExecutionOutstandingSummary
        } | null = null
        let agentRunSegment = 0

        while (true) {
          const currentSegment = agentRunSegment++
          const phaseContract = resolveExecutionPhaseContract({
            scope: runScope,
            automaticPlanningPending: mayContinueAfterPlan,
            objective: selectedAgent.objective,
          })
          for await (const event of agentLoop!.run({
          runId: task.id, runType: "root", sessionId, permissionContextId: sessionId,
          executionSegment: currentSegment,
          userMessage: runMessage, agentId,
          requiredCapabilities: selectedAgent.executionAgent.requiredCapabilities,
          workingDir,
          history,
          attachments: effectiveAttachments,
          scope: runScope,
          effort,
          workflowContext: runWorkflowContext,
          abortSignal: runAbort.signal,
          preferredModelId,
          agentModelRoutes: systemSettings.agentModelRoutes,
          // Automatic planning is a control-plane phase. Domain effects such
          // as network/delegation become available only after the immutable
          // PlanContract has been accepted and execution begins.
          objectiveEffects: mayContinueAfterPlan ? [] : selectedAgent.requiredEffects,
          phaseControlTools: phaseContract.controlToolNames,
          requiredPhaseTools: phaseContract.requiredToolNames,
          disabledTools: [
            ...systemSettings.disabledToolIds,
            ...(systemSettings.webSearchEnabled ? [] : ["websearch", "webfetch"]),
            ...(runScope !== "plan-mode" && planSubmitted ? ["plan"] : []),
          ],
          disabledSkills: systemSettings.disabledSkillIds,
          toolPolicy: {
            toolPolicies: systemSettings.toolPolicies,
            communityAutomation: systemSettings.communityAutomation,
            writePathAllowlist: systemSettings.writePathAllowlist,
            commandAllowlist: systemSettings.commandAllowlist,
            workingDir,
          },
          searchConfig: {
            provider: systemSettings.searchProvider,
            timeoutMs: systemSettings.searchTimeoutMs,
            maxResults: systemSettings.searchMaxResults,
          },
          modelFallbackEnabled,
          fallbackModelIds: modelFallbackEnabled
            ? agentRoute?.fallbackModelIds.filter((id) => modelRouter?.getModel(id))
            : undefined,
          protocolExecutorModelIds,
          objectiveTodos: resolvedObjective.tasks,
          conversationObjective: conversationObjective
            ? {
                id: conversationObjective.id,
                fingerprint: conversationObjectiveFingerprint(conversationObjective),
              }
            : undefined,
          executionState: {
            initial: {
              ...executionSnapshot,
              resourceRequestIds: continuationResources.requestIds,
              continuationContractVersion: 2,
            },
            persist: (snapshot) => {
              executionSnapshot = snapshot
              ExecutionRunRepo.save(task.id, sessionId, snapshot)
              emit("execution-state", {
                state: snapshot.state,
                todos: snapshot.todos,
                followups: snapshot.followups ?? [],
                stopReason: snapshot.stopReason,
                updatedAt: snapshot.updatedAt,
              })
            },
          },
          executionGate: {
            suspendForApproval: (reason) => taskScheduler.waitForApproval(task.id, reason),
            resumeAfterApproval: () => taskScheduler.resumeTaskAndWait(task.id, runAbort.signal),
          },
          onSubAgentInteraction: (request) => brokerSubAgentInteraction({
            rootRunId: task.id,
            sessionId,
            request,
            signal: runAbort.signal,
            publish: (type, payload) => {
              if (type === "question-request") emit(type, publicQuestion(payload))
              else if (type === "approval-request") emit(type, publicApproval(payload))
              else emit(type, payload)
            },
          }),
          objectiveAcceptancePolicy: phaseContract.acceptancePolicy,
          executionDeadline,
          executionBudget: systemSettings.executionBudget,
          activePlan,
          drainGuidance: () => RunGuidanceRepo.consumePending(task.id),
        })) {
          const presentationForwarded = publicAgentEvents.forward(event, { rootRunId: task.id, emit })
          if (event.type === "text-delta") {
            const round = Number((event as any)._step) || 0
            const text = String((event as any).text ?? "")
            messageAccumulator.observeText(currentSegment, round, text)
          } else if (event.type === "finish") {
            const round = Number((event as any)._step) || 0
            messageAccumulator.finishRound(currentSegment, round)
            const transaction = collectedToolCalls.find((call) => call.segment === currentSegment && call.round === round)
            if (transaction && event.reasoningContent) transaction.reasoningContent = event.reasoningContent
            if (transaction && event.reasoningDetails?.length) transaction.reasoningDetails = event.reasoningDetails
            if (transaction && (event as any).originModelId) transaction.originModelId = String((event as any).originModelId)
          } else if (event.type === "tool-call") {
            const round = Number((event as any)._step) || 0
            publicAgentEvents.discardText({ rootRunId: task.id, emit })
            messageAccumulator.observeToolCall(currentSegment, round)
            requestToolCallIds.add(event.id)
            const safeInput = redactSensitiveRecord(event.input)
            collectedToolCalls.push({ id: (event as any).id, name: event.name, input: safeInput, segment: currentSegment, round })
            if (!isInternalOrchestrationTool(event.name)) emit("tool-call", { name: event.name, input: safeInput })
          } else if (event.type === "tool-result") {
            const safeResult = redactSensitiveData(event.result)
            if (event.name === "plan" && safeResult && typeof safeResult === "object" && !(safeResult as any).error) {
              submittedPlan = safeResult as {
                title?: unknown
                content?: unknown
                contract?: PlanContract
              }
            }
            collectedToolResults.push({ id: event.id, name: event.name, result: safeResult, segment: currentSegment, round: Number((event as any)._step) || 0 })
            if (!isInternalOrchestrationTool(event.name)) {
              emit("tool-result", { id: event.id, name: event.name, result: safeResult })
            }
          } else if (presentationForwarded) {
            // Root-model presentation events are projected in one public outlet.
          } else if (event.type === "model-routed") {
            const internalExecution = Boolean((event as any).internalExecution)
            if (!internalExecution) {
              routedModelId = (event as any).modelId
              routedModelName = (event as any).modelName
            }
            routeReason ||= (event as any).reason ?? ""
            routeAttempts.push({
              modelId: (event as any).modelId,
              modelName: (event as any).modelName,
              attempt: Number((event as any).attempt) || routeAttempts.length + 1,
              fallback: Boolean((event as any).fallback),
              reason: (event as any).reason ?? "",
              ...((event as any).previousError ? { previousError: String((event as any).previousError).slice(0, 500) } : {}),
              ...((event as any).attemptId ? { attemptId: String((event as any).attemptId) } : {}),
              scope: "agent",
              segment: Number((event as any).segment) || 0,
              step: Number((event as any).step) || 0,
            })
            // 通知前端实际路由到的模型（可能与请求的 agentId 不同，如 fallback 后切换了模型）
            const publicRouteSignature = `${routedModelId}:${Boolean((event as any).fallback)}`
            if (!internalExecution && publicRouteSignature !== lastPublicRouteSignature) {
              emit("model-routed", {
                modelId: routedModelId,
                modelName: routedModelName,
                attempt: (event as any).attempt,
                fallback: (event as any).fallback,
                reason: (event as any).reason,
                failureReason: summarizeModelFailure((event as any).previousError),
                scope: "agent",
                segment: (event as any).segment,
                step: (event as any).step,
              })
              lastPublicRouteSignature = publicRouteSignature
            }
          } else if (event.type === "plan-submitted") {
            planSubmitted = true
            emit("plan-submitted", submittedPlan ?? {})
          } else if ((event as any).type === "execution-stopped") {
            executionStop = {
              reason: String((event as any).reason ?? "budget-exhausted"),
              outstandingTodos: Number((event as any).outstandingTodos) || 0,
              outstandingSummary: (event as any).outstandingSummary,
            }
            emit("execution-stopped", {
              reason: publicExecutionStopReason(
                executionStop.reason,
                executionStop.outstandingTodos,
                executionStop.outstandingSummary,
              ),
              outstandingTodos: executionStop.outstandingTodos,
              outstandingSummary: executionStop.outstandingSummary,
            })
          } else if ((event as any).type === "execution-continued") {
            executionStop = null
            emit("execution-continued", {
              segment: (event as any).segment,
              outstandingTodos: (event as any).outstandingTodos,
            })
          } else if ((event as any).type === "guidance-applied") {
            executionStop = null
            logOrchestrationEvent({
              sessionId,
              runId: task.id,
              agentId,
              eventType: "root.guidance-applied",
              message: "用户补充要求已进入当前根任务",
              data: {
                requestId: String((event as any).requestId ?? ""),
                segment: currentSegment,
              },
            })
          } else if ((event as any).type === "execution-blocked") {
            publicAgentEvents.discard({ rootRunId: task.id, emit })
            emit("execution-blocked", { reason: (event as any).reason ?? "等待外部条件" })
          } else if (event.type === "error") {
            publicAgentEvents.discard({ rootRunId: task.id, emit })
            hasError = true
            agentError = event.message
            emit("error", { message: event.message })
          }
        }

          executionSnapshot = ExecutionRunRepo.get(task.id)?.snapshot ?? executionSnapshot

          if (!mayContinueAfterPlan || !planSubmitted || !submittedPlan) break
          mayContinueAfterPlan = false
          // Planning and execution have different immutable acceptance
          // contracts. Do not carry a completed planning snapshot into the
          // operational phase of the same root task.
          executionSnapshot = undefined
          executionStop = null
          const liveScope = runtimeAccessManager.getScope(sessionId, executionFlow.scope)
          runScope = liveScope === executionFlow.scope ? executionFlow.executionScope : liveScope
          runtimeAccessManager.set(sessionId, runScope)
          if (!submittedPlan.contract) {
            throw new Error("plan 工具未返回可执行 PlanContract")
          }
          activePlan = compileExecutablePlan(submittedPlan.contract, workingDir)
          logOrchestrationEvent({
            sessionId,
            runId: task.id,
            agentId,
            eventType: "root.tasks-published",
            message: "主 Agent 发布了权威计划任务清单",
            data: {
              runType: "root",
              source: "plan-contract",
              planId: activePlan.identity.planId,
              planVersion: activePlan.identity.version,
              count: activePlan.nodes.length,
              tasks: activePlan.nodes.map((node, index) => ({
                order: index + 1,
                nodeId: node.nodeId,
                content: node.taskContract.objective.slice(0, 240),
                status: "pending",
                priority: "high",
                assignee: node.assigneeAgentId,
                acceptance: node.taskContract.acceptance.join("；").slice(0, 240),
              })),
            },
          })
          runMessage = buildPlannedExecutionMessage(modelMessage, activePlan)
          runWorkflowContext = [
            workflowCtx,
            coordinationCtx,
            "## 执行阶段\n自动规划已完成。当前权限已恢复为用户原先选择的执行范围；直接执行并验证计划，不要再次规划。",
          ].filter(Boolean).join("\n\n")
          emit("execution-phase", { phase: "execution", scope: runScope })
        }

        if (runAbort.signal.aborted) throw abortError()
        let fullResponse = messageAccumulator.delivery()

        if (hasError) {
          llmManager.logCall({
            modelId: routedModelId, modelName: routedModelName, agentId, sessionId,
            prompt: message.slice(0, 200), response: fullResponse.slice(0, 200),
            tokens: { prompt: Math.ceil(modelMessage.length / 4), completion: Math.ceil(fullResponse.length / 4) },
            latency: Date.now() - startTime, success: false, error: agentError || "Agent 执行失败",
            routeReason, routeAttempts, timestamp: Date.now(),
          })
          const reason = agentError || "Agent 执行失败"
          const failedExecution = ExecutionRunRepo.get(task.id)?.snapshot ?? executionSnapshot
          if (failedExecution) {
            executionSnapshot = settleExecutionSnapshot(failedExecution, "failed", reason)
            ExecutionRunRepo.save(task.id, sessionId, executionSnapshot)
            emit("execution-state", publicExecutionState(executionSnapshot))
          }
          taskScheduler.failTask(task.id, reason)
          emitTaskStatus()
          emit("done", { sessionId, taskId: task.id, status: task.status, error: reason })
          return
        }

        let finalExecution = ExecutionRunRepo.get(task.id)?.snapshot ?? executionSnapshot
        if (planSubmitted && runScope === "plan-mode" && finalExecution?.state === "running") {
          finalExecution = {
            ...finalExecution,
            state: "blocked",
            stopReason: "等待用户确认计划",
            updatedAt: Date.now(),
          }
          ExecutionRunRepo.save(task.id, sessionId, finalExecution)
        }
        const terminal = classifyExecutionTerminal(finalExecution, executionStop, {
          requirePublicDelivery: true,
          publicDelivery: fullResponse,
        })
        if (terminal.status === "blocked" && !fullResponse.trim()) {
          fullResponse = projectPublicProblem(terminal.reason, "blocked").message
        }
        const deliveryContractRejected = terminal.status === "failed"
          && finalExecution?.state === "completed"
          && !fullResponse.trim()

        for (const artifact of persistSchematicConversationSummaries(sessionId, collectedToolResults, fullResponse, workingDir)) {
          emit("artifact-updated", { revision: artifact.revision, artifact })
        }

        if (fullResponse) {
          const aseq = MessageRepo.latestSeq(sessionId) + 1
          // 截断 tool_results 防止 JSON 列膨胀：单个 result 最多 50KB，总量最多 500KB
          const publicCalls = publicToolRecords(collectedToolCalls)
          const truncResults = publicToolRecords(collectedToolResults).map(tr => ({
            id: tr.id, name: tr.name, segment: tr.segment, round: tr.round,
            result: typeof tr.result === "string" ? tr.result.slice(0, 50_000)
              : JSON.stringify(tr.result).slice(0, 50_000),
          }))
          const resultsJson = truncResults.length > 0 ? JSON.stringify(truncResults) : null
          const safeResults = resultsJson && resultsJson.length > 500_000 ? resultsJson.slice(0, 500_000) + '...' : resultsJson
          MessageRepo.create({
            session_id: sessionId, request_id: requestId,
            role: "assistant", content: fullResponse, agent_id: agentId,
            tool_calls: publicCalls.length > 0 ? JSON.stringify(publicCalls) : null,
            tool_results: safeResults,
            seq: aseq, timestamp: Date.now(),
          })
        }

        // 记录 LLM 调用日志（用实际路由到的 modelId，而非 agentId）
        const promptTokens = Math.ceil(modelMessage.length / 4)
        const completionTokens = Math.ceil(fullResponse.length / 4)
        llmManager.logCall({
          modelId: routedModelId, modelName: routedModelName, agentId, sessionId,
          prompt: message.slice(0, 200),
          response: fullResponse.slice(0, 200),
          tokens: { prompt: promptTokens, completion: completionTokens },
          latency: Date.now() - startTime,
          success: !deliveryContractRejected,
          routeReason,
          routeAttempts,
          timestamp: Date.now(),
        })
        llmManager.trackTokens({
          modelId: routedModelId, modelName: routedModelName,
          promptTokens, completionTokens,
        })

        let deliveryFiles: DeliveredFile[] = []
        if (terminal.status !== "blocked" || finalExecution?.state !== "waiting-approval") {
          taskScheduler.cancelDescendants(task.id)
        }
        if (terminal.status === "interrupted") {
          const reason = terminal.reason
          if (finalExecution) {
            finalExecution = settleExecutionSnapshot(finalExecution, "interrupted", reason)
            ExecutionRunRepo.save(task.id, sessionId, finalExecution)
            emit("execution-state", publicExecutionState(finalExecution))
          }
          taskScheduler.interruptTask(task.id, reason)
        } else if (terminal.status === "blocked") {
          const reason = terminal.reason
          if (finalExecution && finalExecution.state !== "waiting-approval") {
            finalExecution = settleExecutionSnapshot(finalExecution, "blocked", reason)
            ExecutionRunRepo.save(task.id, sessionId, finalExecution)
            emit("execution-state", publicExecutionState(finalExecution))
          }
          taskScheduler.blockTask(task.id, reason)
        } else if (terminal.status === "failed") {
          const reason = terminal.reason
          if (finalExecution) {
            finalExecution = settleExecutionSnapshot(finalExecution, "failed", reason)
            ExecutionRunRepo.save(task.id, sessionId, finalExecution)
            emit("execution-state", publicExecutionState(finalExecution))
          }
          taskScheduler.failTask(task.id, reason)
          if (deliveryContractRejected) emit("error", { message: reason })
        } else if (terminal.status === "completed" && finalExecution) {
          resolveCompletedExecutionLineage(resumeSource?.taskId, sessionId, finalExecution)
          if (conversationObjective) {
            ConversationObjectiveRepo.complete(conversationObjective.id, task.id)
          }
          taskScheduler.completeTask(task.id, fullResponse)
          deliveryFiles = finalizeDeliveredFiles(TaskRunRepo.get(task.id))
        }
        emitTaskStatus()
        emit("done", { sessionId, taskId: task.id, status: task.status, result: fullResponse, error: task.error, deliveryFiles })
      } catch (err: any) {
        if (runAbort.signal.aborted || err?.name === "AbortError") {
          cancellationCaught = true
          const cancelledExecution = ExecutionRunRepo.get(task.id)?.snapshot ?? executionSnapshot
          if (cancelledExecution) ExecutionRunRepo.save(task.id, sessionId, settleExecutionSnapshot(cancelledExecution, "cancelled", "用户取消了任务"))
          taskScheduler.cancel(task.id)
        } else {
          const failedExecution = ExecutionRunRepo.get(task.id)?.snapshot ?? executionSnapshot
          if (failedExecution) ExecutionRunRepo.save(task.id, sessionId, settleExecutionSnapshot(failedExecution, "failed", err.message))
          taskScheduler.failTask(task.id, err.message)
          emitTaskStatus()
          emit("error", { message: err.message })
          emit("done", { sessionId, taskId: task.id, status: task.status, error: err.message })
        }
      } finally {
        clearInterval(heartbeat)
        if (task.status === "cancelling") {
          taskScheduler.confirmWorkerExit(task.id, task.error || "根执行体已退出")
        }
        if (cancellationCaught) {
          emitTaskStatus()
          emit("done", { sessionId, taskId: task.id, status: task.status, error: "任务已取消" })
        }
        if (["completed", "failed", "cancelled", "interrupted", "blocked"].includes(task.status)) {
          RunGuidanceRepo.rejectPending(task.id, "当前任务已经结束，未能应用这条引导")
          taskScheduler.cancelDescendants(task.id)
        }
        const terminalReason = task.status === "cancelled"
          ? "任务已取消，工具执行被中断"
          : task.status === "interrupted"
            ? `任务已暂停: ${task.error || "达到安全执行边界"}`
          : task.status === "blocked"
            ? `任务等待外部条件，工具执行已停止: ${task.error || "等待条件恢复"}`
            : task.status === "failed"
              ? `任务失败，工具执行被中断: ${task.error || agentError || "未知错误"}`
              : "任务已结束，但工具未返回终态"
        for (const execution of ToolExecutionRepo.failRunningByToolCalls(sessionId, [...requestToolCallIds], terminalReason)) {
          if (!isInternalOrchestrationTool(execution.toolName)) emit("tool-execution", execution)
        }
        if (task.status === "completed") {
          SessionCommandRepo.finish(requestId, "completed")
        } else if (task.status === "cancelled") {
          SessionCommandRepo.finish(requestId, "cancelled", task.error)
        } else if (task.status === "blocked") {
          SessionCommandRepo.finish(requestId, "blocked", task.error || agentError || "任务正在等待外部条件")
        } else if (["failed", "interrupted"].includes(task.status)) {
          SessionCommandRepo.finish(requestId, "failed", task.error || agentError || `任务以 ${task.status} 结束`)
        }
        try { controller.close() } catch {}
      }
    },
    cancel() {
      // SSE 是展示通道，不是任务生命周期。WebView 或网络中断时让后台任务继续，
      // 前端通过任务状态 API 恢复；只有显式取消 API 才会触发 abortRun。
      sseAborted = true
    },
  })

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  })
  } catch (error) {
    const failure = asRootAdmissionPhaseError(
      error,
      "execution-preparation",
      "主 Agent 无法完成执行准备",
      "root-execution-preparation-failed",
    )
    failAdmittedChatRoot(admittedRoot, failure)
    const terminalTask = taskScheduler.getTask(task.id) ?? task
    const problem = projectPublicProblem(failure.message)
    return json({
      error: problem.message,
      problem,
      requestId,
      task: taskView(terminalTask),
      diagnostic: {
        kind: failure.kind,
        stage: failure.stage,
        diagnosticId: problem.diagnosticId,
        nextActions: ["修复对应准备阶段后重新提交当前命令"],
      },
    }, { ...corsHeaders, status: failure.httpStatus })
  }
}

function abortError(): Error {
  const error = new Error("请求已取消")
  error.name = "AbortError"
  return error
}
