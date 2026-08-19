import type { AgentLoop } from "./agent-loop"
import type { AgentRegistry } from "../agent/registry"
import type { ModelRouter } from "../model-router"
import { AgentChain } from "./agent-chain"
import { taskScheduler } from "./task-scheduler"
import { getEffectiveSystemSettings } from "./project-settings"
import { MessageRepo, SessionRepo } from "../store/repository"
import {
  normalizeFailurePolicy, WorkflowRepo, WorkflowScheduleRepo, type WorkflowFailurePolicy,
  type WorkflowNodeCondition, type WorkflowNodeView, type WorkflowRunView, type WorkflowScheduleView,
} from "../store/workflow"
import {
  WorkflowTemplateRepo, type CustomWorkflowTemplateView, type WorkflowTemplateNodeDefinition,
} from "../store/workflow-template"
import { deliverWorkflowWebhook } from "./workflow-webhook"
import type { ToolRegistry } from "../tool/registry.ts"
import {
  normalizeResourceClaims, normalizeTaskContract, normalizeTaskContractRevision,
} from "./run-contract.ts"
import { executeAgentRun } from "./run-executor.ts"
import { runGraphService } from "./run-graph.ts"
import { RunGraphRepo, type RunNodeStatus } from "../store/run-graph.ts"
import { RunContractRepo } from "../store/run-contract.ts"
import { buildStructuredTaskResult, settleCompletedTask } from "./task-settlement.ts"
import { workspaceRevisionService } from "./workspace-revision.ts"

export interface WorkflowTemplateView {
  id: string
  name: string
  description: string
  custom: boolean
  agents: Array<{ id: string; name: string }>
  nodes: WorkflowTemplateNodeDefinition[]
  failurePolicy: WorkflowFailurePolicy
}

type ActiveRun = { controller: AbortController; nodeId: string; taskId: string }
type DesiredAction = "cancel" | "takeover"

const TEMPLATE_META: Record<string, { name: string; description: string }> = {
  "full-development": { name: "完整开发", description: "从需求分析到文档交付的完整嵌入式开发流程" },
  "quick-prototype": { name: "快速原型", description: "硬件分析、固件实现与基础验证" },
  debugging: { name: "问题调试", description: "定位问题、验证原因并完成代码修复" },
  "component-selection": { name: "器件选型", description: "梳理约束、检索器件并评审方案" },
  "ui-development": { name: "UI 开发", description: "确认显示硬件、实现界面并测试验证" },
}

export class WorkflowEngine {
  private active = new Map<string, Map<string, ActiveRun>>()
  private desiredActions = new Map<string, DesiredAction>()
  private scheduleTimer: ReturnType<typeof setInterval> | null = null
  private scheduleTicking = false

  constructor(
    private agentLoop: AgentLoop,
    private agentRegistry: AgentRegistry,
    private modelRouter: ModelRouter,
    private toolRegistry: ToolRegistry,
  ) {}

  recoverInterrupted(): number {
    return WorkflowRepo.recoverInterrupted()
  }

  templates(): WorkflowTemplateView[] {
    const builtins = Object.entries(AgentChain.WORKFLOWS).map(([id, agentIds]) => ({
      id,
      name: TEMPLATE_META[id]?.name ?? id,
      description: TEMPLATE_META[id]?.description ?? "多 Agent 协作流程",
      custom: false,
      failurePolicy: normalizeFailurePolicy(),
      agents: agentIds.map((agentId) => ({
        id: agentId,
        name: this.agentRegistry.get(agentId)?.name ?? agentId,
      })),
      nodes: agentIds.map((agentId, index) => ({
        id: `step-${index + 1}`,
        title: this.agentRegistry.get(agentId)?.name ?? agentId,
        agentId,
        prompt: "",
        dependsOn: index === 0 ? [] : [`step-${index}`],
      })),
    }))
    const custom = WorkflowTemplateRepo.list().map((template) => this.toTemplateView(template))
    return [...builtins, ...custom]
  }

  createTemplate(input: unknown): WorkflowTemplateView {
    const normalized = this.normalizeTemplate(input)
    return this.toTemplateView(WorkflowTemplateRepo.create(normalized))
  }

  updateTemplate(id: string, input: unknown): WorkflowTemplateView {
    if (!id.startsWith("custom-")) throw new Error("内置模板不能修改")
    const normalized = this.normalizeTemplate(input)
    const updated = WorkflowTemplateRepo.update(id, normalized)
    if (!updated) throw new Error("工作流模板不存在")
    return this.toTemplateView(updated)
  }

  deleteTemplate(id: string): void {
    if (!id.startsWith("custom-")) throw new Error("内置模板不能删除")
    if (!WorkflowTemplateRepo.get(id)) throw new Error("工作流模板不存在")
    if (WorkflowScheduleRepo.list().some((schedule) => schedule.templateId === id)) {
      throw new Error("模板仍被定时计划引用，请先删除对应计划")
    }
    WorkflowTemplateRepo.delete(id)
  }

  create(input: { sessionId: string; templateId: string; goal: string; workingDir: string }): WorkflowRunView {
    const session = SessionRepo.get(input.sessionId)
    if (!session) throw new Error("会话不存在")
    const template = this.templates().find((item) => item.id === input.templateId)
    if (!template) throw new Error("工作流模板不存在")
    const goal = input.goal.trim()
    if (!goal || goal.length > 50_000) throw new Error("工作流目标为空或过长")
    const nodes = template.nodes.map((definition, index) => {
      const agent = this.agentRegistry.get(definition.agentId)
      if (!agent) throw new Error(`工作流 Agent 不存在: ${definition.agentId}`)
      return {
        key: definition.id,
        title: definition.title,
        agentId: definition.agentId,
        prompt: buildNodePrompt(goal, agent.name, index + 1, template.nodes.length, definition.prompt, definition.title),
        dependsOn: definition.dependsOn,
        condition: definition.condition,
        resourceClaims: definition.resourceClaims,
      }
    })
    const run = WorkflowRepo.create({ ...input, goal, nodes, failurePolicy: template.failurePolicy })
    this.registerRunGraph(run)
    return run
  }

  replay(workflowId: string, start = true): WorkflowRunView {
    const source = this.requireRun(workflowId)
    if ((this.active.get(workflowId)?.size ?? 0) > 0) throw new Error("运行中的工作流不能重放")
    const replay = WorkflowRepo.create({
      sessionId: source.sessionId, templateId: source.templateId, goal: source.goal,
      workingDir: source.workingDir, failurePolicy: source.failurePolicy,
      nodes: source.nodes.map((node) => ({
        key: node.id, title: node.title, agentId: node.agentId, prompt: node.prompt,
        dependsOn: node.dependsOn, condition: node.condition, resourceClaims: node.resourceClaims,
      })),
    })
    this.registerRunGraph(replay)
    return start ? this.start(replay.id) : replay
  }

  start(workflowId: string): WorkflowRunView {
    const run = this.requireRun(workflowId)
    if ((this.active.get(workflowId)?.size ?? 0) > 0) return run
    if (!["planned", "paused"].includes(run.status)) throw new Error("当前状态不能启动")
    if (run.nodes.some((node) => node.status === "waiting-human")) throw new Error("请先完成人工接管节点")
    for (const node of run.nodes.filter((item) => item.status === "paused")) {
      WorkflowRepo.updateNode(node.id, { status: "pending", error: "应用重启后恢复，执行前请重新检查现场状态" })
    }
    WorkflowRepo.updateRun(workflowId, {
      status: "running", startedAt: run.startedAt ?? Date.now(), completedAt: null as unknown as undefined,
    })
    this.transitionGraph(run.id, "running")
    void this.execute(workflowId).catch((error) => this.failRun(workflowId, error))
    return this.requireRun(workflowId)
  }

  pause(workflowId: string): WorkflowRunView {
    const run = this.requireRun(workflowId)
    if (run.status !== "running") throw new Error("只有运行中的工作流可以暂停")
    WorkflowRepo.updateRun(workflowId, { status: (this.active.get(workflowId)?.size ?? 0) > 0 ? "pausing" : "paused" })
    this.transitionGraph(run.id, "waiting")
    return this.requireRun(workflowId)
  }

  resume(workflowId: string): WorkflowRunView {
    const run = this.requireRun(workflowId)
    if (run.status !== "paused") throw new Error("当前状态不能恢复")
    return this.start(workflowId)
  }

  cancel(workflowId: string): WorkflowRunView {
    const run = this.requireRun(workflowId)
    if (["completed", "cancelled"].includes(run.status)) return run
    WorkflowRepo.updateRun(workflowId, { status: "cancelling" })
    this.transitionGraph(run.id, "waiting")
    for (const active of this.active.get(workflowId)?.values() ?? []) {
      this.desiredActions.set(actionKey(workflowId, active.nodeId), "cancel")
      taskScheduler.cancel(active.taskId)
    }
    for (const node of run.nodes.filter((item) => ["pending", "queued", "paused"].includes(item.status))) {
      WorkflowRepo.updateNode(node.id, { status: "cancelled", completedAt: Date.now() })
    }
    if ((this.active.get(workflowId)?.size ?? 0) === 0) this.finishCancellation(workflowId)
    this.refreshReport(workflowId)
    return this.requireRun(workflowId)
  }

  retryNode(workflowId: string, nodeId: string): WorkflowRunView {
    const run = this.requireRun(workflowId)
    if ((this.active.get(workflowId)?.size ?? 0) > 0) throw new Error("请先暂停或取消当前执行")
    const node = run.nodes.find((item) => item.id === nodeId)
    if (!node) throw new Error("工作流节点不存在")
    if (!["failed", "cancelled", "waiting-human", "paused"].includes(node.status)) throw new Error("当前节点不能重试")
    const retryIds = descendantNodeIds(run, node.id)
    for (const item of run.nodes.filter((candidate) => retryIds.has(candidate.id))) {
      WorkflowRepo.updateNode(item.id, {
        status: "pending", result: "", error: "", taskRunId: "", startedAt: 0, completedAt: 0,
      })
    }
    WorkflowRepo.updateRun(workflowId, { status: "paused", currentNodeId: node.id, completedAt: 0 })
    this.refreshReport(workflowId)
    return this.resume(workflowId)
  }

  takeOver(workflowId: string, nodeId: string): WorkflowRunView {
    const run = this.requireRun(workflowId)
    const node = run.nodes.find((item) => item.id === nodeId)
    if (!node) throw new Error("工作流节点不存在")
    if (["completed", "skipped"].includes(node.status)) throw new Error("已结束节点不能接管")
    const active = this.active.get(workflowId)?.get(nodeId)
    this.desiredActions.set(actionKey(workflowId, nodeId), "takeover")
    if (active) taskScheduler.cancel(active.taskId)
    WorkflowRepo.updateNode(node.id, { status: "waiting-human", error: "等待人工提交处理结果" })
    WorkflowRepo.updateRun(workflowId, { status: "paused", currentNodeId: node.id })
    this.refreshReport(workflowId)
    return this.requireRun(workflowId)
  }

  completeHuman(workflowId: string, nodeId: string, result: string): WorkflowRunView {
    const run = this.requireRun(workflowId)
    const node = run.nodes.find((item) => item.id === nodeId)
    if (!node || node.status !== "waiting-human") throw new Error("节点未处于人工接管状态")
    const value = result.trim()
    if (!value || value.length > 100_000) throw new Error("人工处理结果为空或过长")
    WorkflowRepo.updateNode(nodeId, { status: "completed", result: value, error: "", completedAt: Date.now() })
    WorkflowRepo.updateRun(workflowId, { status: "paused", currentNodeId: nodeId })
    this.desiredActions.delete(actionKey(workflowId, nodeId))
    this.refreshReport(workflowId)
    return this.resume(workflowId)
  }

  startSchedulePolling(): void {
    if (this.scheduleTimer) return
    this.scheduleTimer = setInterval(() => void this.runDueSchedules(), 15_000)
    void this.runDueSchedules()
  }

  close(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.scheduleTimer = null
    for (const [workflowId, activeNodes] of this.active) {
      for (const active of activeNodes.values()) {
        this.desiredActions.set(actionKey(workflowId, active.nodeId), "cancel")
        taskScheduler.cancel(active.taskId)
      }
    }
  }

  async runScheduleNow(scheduleId: string): Promise<WorkflowRunView> {
    const schedule = WorkflowScheduleRepo.get(scheduleId)
    if (!schedule) throw new Error("定时计划不存在")
    return this.launchSchedule(schedule, Date.now())
  }

  private async execute(workflowId: string): Promise<void> {
    while (true) {
      const run = this.requireRun(workflowId)
      if (run.status === "cancelled") return
      if (run.status === "cancelling") {
        if ((this.active.get(workflowId)?.size ?? 0) === 0) this.finishCancellation(workflowId)
        return
      }
      if (run.status === "paused" || run.status === "failed") return
      if (run.status === "pausing") {
        WorkflowRepo.updateRun(workflowId, { status: "paused" })
        this.refreshReport(workflowId)
        return
      }
      const skipped = skippableNodes(run)
      if (skipped.length > 0) {
        for (const node of skipped) {
          WorkflowRepo.updateNode(node.id, {
            status: "skipped", result: "条件不满足，节点已跳过。", error: "", completedAt: Date.now(),
          })
        }
        this.refreshReport(workflowId)
        continue
      }
      const nodes = readyNodes(run)
      if (nodes.length === 0) {
        let terminalEvent: "completed" | "failed" | null = null
        const failed = run.nodes.find((item) => item.status === "failed")
        if (failed) {
          for (const pending of run.nodes.filter((item) => item.status === "pending")) {
            WorkflowRepo.updateNode(pending.id, {
              status: "cancelled",
              error: `依赖节点失败，未执行：${failed.title}`,
              completedAt: Date.now(),
            })
          }
          WorkflowRepo.updateRun(workflowId, { status: "failed", completedAt: Date.now() })
          this.transitionGraph(workflowId, "failed")
          terminalEvent = "failed"
        }
        else if (run.nodes.every((item) => ["completed", "skipped"].includes(item.status))) {
          WorkflowRepo.updateRun(workflowId, { status: "completed", currentNodeId: "", completedAt: Date.now() })
          this.transitionGraph(workflowId, "completed")
          terminalEvent = "completed"
        } else {
          WorkflowRepo.updateRun(workflowId, { status: "paused" })
          this.transitionGraph(workflowId, "waiting")
        }
        this.refreshReport(workflowId)
        if (terminalEvent === "completed") this.persistCompletionMessage(workflowId)
        if (terminalEvent) void deliverWorkflowWebhook(this.requireRun(workflowId), terminalEvent).catch(() => {})
        return
      }
      const executions = nodes.map((node) => this.executeNode(run, node))
      const results = await settleWorkflowSiblings(
        executions,
        run.failurePolicy.siblingFailure ?? "continue",
        () => this.cancelActiveSiblings(workflowId, "同批节点失败，按 fail-fast 策略取消"),
      )
      const rejection = results.find((item): item is PromiseRejectedResult => item.status === "rejected")
      if (rejection && (run.failurePolicy.siblingFailure ?? "continue") === "fail-fast") {
        const latest = this.requireRun(workflowId)
        if (latest.status === "cancelling") {
          this.finishCancellation(workflowId)
          return
        }
        const failed = latest.nodes.find((item) => item.status === "failed")
        for (const pending of latest.nodes.filter((item) => item.status === "pending")) {
          WorkflowRepo.updateNode(pending.id, {
            status: "cancelled",
            error: `工作流 fail-fast：${failed?.title ?? "同批节点"}失败`,
            completedAt: Date.now(),
          })
        }
        WorkflowRepo.updateRun(workflowId, { status: "failed", completedAt: Date.now() })
        this.transitionGraph(workflowId, "failed")
        this.refreshReport(
          workflowId,
          rejection.reason instanceof Error ? rejection.reason.message : String(rejection.reason),
        )
        void deliverWorkflowWebhook(this.requireRun(workflowId), "failed").catch(() => {})
        return
      }
    }
  }

  private async executeNode(run: WorkflowRunView, node: WorkflowNodeView): Promise<void> {
    const controller = new AbortController()
    const previousAttempt = node.taskRunId ? RunContractRepo.get(node.taskRunId) : null
    const previousFailure = node.error?.trim()
    const adaptivePrompt = previousFailure
      ? `${node.prompt}\n\n上一次执行失败证据：\n${previousFailure}\n请保留原目标，分析失败原因并改用不同的可行策略；不要原样重复失败调用。`
      : node.prompt
    const task = taskScheduler.enqueue({
      sessionId: run.sessionId, agentId: node.agentId, priority: 4,
      message: `[工作流] ${node.title}: ${run.goal}`, workingDir: run.workingDir,
      type: "background", scope: "auto-edit", effort: "on",
      parentRunId: run.id,
      laneKey: `conversation:${run.sessionId}`,
      laneOwner: `workflow:${run.id}`,
      resourceClaims: this.nodeResourceClaims(node, run.workingDir),
      onCancel: () => controller.abort(),
    })
    for (const dependencyId of node.dependsOn) {
      const dependencyTaskId = run.nodes.find((item) => item.id === dependencyId)?.taskRunId
      if (dependencyTaskId) runGraphService.addEdge(run.id, task.id, dependencyTaskId, "depends-on")
    }
    const proposedContract = {
      logicalTaskId: node.id,
      revisionOf: previousAttempt?.runId,
      attempt: node.attempt + 1,
      objective: node.title,
      instructions: adaptivePrompt,
      constraints: ["必须基于工作区真实状态执行", "必须提供可持久化的工具验证证据"],
      acceptance: [`完成并验证工作流节点：${node.title}`],
      inputArtifacts: [],
      expectedOutputs: [],
      resources: this.nodeResourceClaims(node, run.workingDir),
    }
    const contract = previousAttempt
      ? normalizeTaskContractRevision(previousAttempt.contract, proposedContract, run.workingDir)
      : normalizeTaskContract(proposedContract, run.workingDir)
    contract.logicalTaskId = node.id
    contract.revisionOf = previousAttempt?.runId
    contract.attempt = node.attempt + 1
    try {
      RunContractRepo.create({
        runId: task.id,
        sessionId: run.sessionId,
        parentRunId: run.id,
        agentId: node.agentId,
        contract,
      })
      runGraphService.bindContract(task.id, contract)
      if (contract.resources.writes.length > 0) {
        workspaceRevisionService.open(task.id, run.workingDir)
      }
    } catch (error) {
      taskScheduler.cancel(task.id)
      const message = error instanceof Error ? error.message : String(error)
      WorkflowRepo.updateNode(node.id, { status: "failed", error: message, completedAt: Date.now() })
      WorkflowRepo.updateRun(run.id, { status: "failed", completedAt: Date.now() })
      this.transitionGraph(run.id, "failed")
      throw error
    }
    const activeNodes = this.active.get(run.id) ?? new Map<string, ActiveRun>()
    activeNodes.set(node.id, { controller, nodeId: node.id, taskId: task.id })
    this.active.set(run.id, activeNodes)
    WorkflowRepo.updateNode(node.id, {
      status: "queued", attempt: node.attempt + 1, taskRunId: task.id, error: "", startedAt: Date.now(), completedAt: 0,
    })
    WorkflowRepo.updateRun(run.id, { status: "running", currentNodeId: node.id })
    try {
      await taskScheduler.waitForTurn(task.id, controller.signal)
      WorkflowRepo.updateNode(node.id, { status: "running" })
      const latest = this.requireRun(run.id)
      const context = [
        completedContext(latest, node),
        previousFailure
          ? `当前节点上一轮失败证据：${previousFailure}\n此证据用于调整策略，不代表任务目标已终止。`
          : "",
      ].filter(Boolean).join("\n\n")
      const settings = getEffectiveSystemSettings(run.workingDir)
      const route = settings.agentModelRoutes[node.agentId]
      const execution = await executeAgentRun({
        loop: this.agentLoop,
        run: {
        runId: task.id,
        parentRunId: run.id,
        runType: "workflow-node",
        checkpointKey: task.id,
        sessionId: run.sessionId,
        permissionContextId: run.sessionId,
        userMessage: adaptivePrompt,
        agentId: node.agentId,
        workingDir: run.workingDir,
        workflowContext: context,
        scope: settings.defaultScope,
        effort: settings.defaultEffort,
        abortSignal: controller.signal,
        preferredModelId: route?.primaryModelId || settings.defaultModelId || undefined,
        agentModelRoutes: settings.agentModelRoutes,
        disabledTools: [...settings.disabledToolIds, ...(settings.webSearchEnabled ? [] : ["websearch", "webfetch"])],
        disabledSkills: settings.disabledSkillIds,
        toolPolicy: {
          toolPolicies: settings.toolPolicies,
          communityAutomation: settings.communityAutomation,
          writePathAllowlist: settings.writePathAllowlist,
          commandAllowlist: settings.commandAllowlist,
          workingDir: run.workingDir,
        },
        searchConfig: {
          provider: settings.searchProvider,
          timeoutMs: settings.searchTimeoutMs,
          maxResults: settings.searchMaxResults,
        },
        modelFallbackEnabled: settings.modelFallbackEnabled,
        fallbackModelIds: route?.fallbackModelIds.filter((id) => this.modelRouter.getModel(id)),
        executionDeadline: Date.now() + settings.executionBudget.rootWindowMs,
        executionBudget: settings.executionBudget,
        executionGate: {
          suspendForApproval: (reason) => taskScheduler.waitForApproval(task.id, reason),
          resumeAfterApproval: () => taskScheduler.resumeTaskAndWait(task.id, controller.signal),
        },
        },
      })
      if (controller.signal.aborted) throw abortError()
      const terminal = execution.terminal
      if (terminal.status === "interrupted") {
        taskScheduler.interruptTask(task.id, terminal.reason)
        WorkflowRepo.updateNode(node.id, { status: "paused", error: terminal.reason, completedAt: Date.now() })
        WorkflowRepo.updateRun(run.id, { status: "paused", currentNodeId: node.id })
        this.refreshReport(run.id)
        return
      }
      if (terminal.status === "blocked") {
        taskScheduler.blockTask(task.id, terminal.reason)
        WorkflowRepo.updateNode(node.id, { status: "waiting-human", error: terminal.reason })
        WorkflowRepo.updateRun(run.id, { status: "paused", currentNodeId: node.id })
        this.refreshReport(run.id)
        return
      }
      if (terminal.status === "failed") throw new Error(terminal.reason)
      const result = execution.output.trim() || "节点已执行完成，未返回文本结果。"
      const structuredResult = buildStructuredTaskResult({
        runId: task.id,
        sessionId: run.sessionId,
        status: "completed",
        summary: `工作流节点 ${node.title} 已提交结果`,
        output: result,
      })
      if (!await settleCompletedTask({
        runId: task.id,
        sessionId: run.sessionId,
        result: structuredResult,
        resultText: result,
        workflowNodeId: node.id,
      })) {
        throw new Error("工作流节点完成结算时调度状态已变化")
      }
      if (!taskScheduler.adoptCompletedSettlement(task.id, result)) {
        throw new Error("工作流节点完成结算的内存投影失败")
      }
      WorkflowRepo.updateNode(node.id, { status: "completed", result, error: "", completedAt: Date.now() })
      this.refreshReport(run.id)
    } catch (error) {
      const key = actionKey(run.id, node.id)
      const action = this.desiredActions.get(key)
      if (action === "takeover") {
        WorkflowRepo.updateNode(node.id, { status: "waiting-human", error: "等待人工提交处理结果" })
        WorkflowRepo.updateRun(run.id, { status: "paused" })
      } else if (action === "cancel") {
        WorkflowRepo.updateNode(node.id, { status: "cancelled", completedAt: Date.now() })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        const latestNode = WorkflowRepo.getNode(node.id)
        taskScheduler.failTask(task.id, message)
        if (latestNode && latestNode.attempt <= run.failurePolicy.maxRetries) {
          WorkflowRepo.updateNode(node.id, {
            status: "pending",
            error: `第 ${latestNode.attempt} 次执行失败，等待自动重试：${message}`,
            startedAt: 0, completedAt: 0,
          })
          this.refreshReport(run.id)
          if (run.failurePolicy.delaySeconds > 0) await wait(run.failurePolicy.delaySeconds * 1_000)
          return
        }
        WorkflowRepo.updateNode(node.id, { status: "failed", error: message, completedAt: Date.now() })
      }
      this.refreshReport(run.id)
      throw error
    } finally {
      if (taskScheduler.getTask(task.id)?.status === "cancelling") {
        taskScheduler.confirmWorkerExit(task.id)
      }
      const active = this.active.get(run.id)
      active?.delete(node.id)
      if (active?.size === 0) this.active.delete(run.id)
      const key = actionKey(run.id, node.id)
      if (this.desiredActions.get(key) !== "takeover") this.desiredActions.delete(key)
    }
  }

  private failRun(workflowId: string, error: unknown): void {
    const run = WorkflowRepo.get(workflowId)
    if (!run || ["cancelled", "paused"].includes(run.status)) return
    const message = error instanceof Error ? error.message : String(error)
    WorkflowRepo.updateRun(workflowId, { status: "failed", completedAt: Date.now() })
    this.transitionGraph(workflowId, "failed")
    for (const active of this.active.get(workflowId)?.values() ?? []) {
      this.desiredActions.set(actionKey(workflowId, active.nodeId), "cancel")
      taskScheduler.cancel(active.taskId)
    }
    for (const node of run.nodes.filter((item) => ["pending", "queued", "running", "paused"].includes(item.status))) {
      WorkflowRepo.updateNode(node.id, {
        status: "cancelled", error: `工作流异常终止：${message}`.slice(0, 2_000), completedAt: Date.now(),
      })
    }
    this.refreshReport(workflowId, message)
    void deliverWorkflowWebhook(this.requireRun(workflowId), "failed").catch(() => {})
  }

  private cancelActiveSiblings(workflowId: string, reason: string): void {
    for (const active of this.active.get(workflowId)?.values() ?? []) {
      const task = taskScheduler.getTask(active.taskId)
      if (!task || task.status === "failed" || task.status === "cancelled") continue
      this.desiredActions.set(actionKey(workflowId, active.nodeId), "cancel")
      taskScheduler.cancel(active.taskId)
      WorkflowRepo.updateNode(active.nodeId, { error: reason })
    }
  }

  private finishCancellation(workflowId: string): void {
    const run = this.requireRun(workflowId)
    for (const node of run.nodes.filter((item) =>
      !["completed", "failed", "skipped", "cancelled"].includes(item.status))) {
      WorkflowRepo.updateNode(node.id, { status: "cancelled", completedAt: Date.now() })
    }
    WorkflowRepo.updateRun(workflowId, { status: "cancelled", completedAt: Date.now() })
    this.transitionGraph(workflowId, "cancelled")
    this.refreshReport(workflowId)
  }

  private refreshReport(workflowId: string, runtimeError?: string): string {
    const run = this.requireRun(workflowId)
    const report = buildWorkflowReport(run, runtimeError)
    WorkflowRepo.updateRun(workflowId, { report })
    return report
  }

  private persistCompletionMessage(workflowId: string): void {
    const run = this.requireRun(workflowId)
    const report = run.report ?? buildWorkflowReport(run)
    const mainAgentId = SessionRepo.get(run.sessionId)?.agent_id ?? "auto"
    MessageRepo.create({
      session_id: run.sessionId, request_id: null,
      role: "assistant", content: report, agent_id: mainAgentId,
      tool_calls: null, tool_results: null, seq: MessageRepo.latestSeq(run.sessionId) + 1, timestamp: Date.now(),
    })
  }

  private toTemplateView(template: CustomWorkflowTemplateView): WorkflowTemplateView {
    const agents = [...new Set(template.nodes.map((node) => node.agentId))].map((agentId) => ({
      id: agentId,
      name: this.agentRegistry.get(agentId)?.name ?? agentId,
    }))
    return {
      id: template.id, name: template.name, description: template.description,
      custom: true, agents, nodes: template.nodes, failurePolicy: template.failurePolicy,
    }
  }

  private normalizeTemplate(input: unknown): Pick<CustomWorkflowTemplateView, "name" | "description" | "nodes" | "failurePolicy"> {
    if (!input || typeof input !== "object") throw new Error("模板内容无效")
    const value = input as Record<string, unknown>
    const name = typeof value.name === "string" ? value.name.trim().slice(0, 80) : ""
    const description = typeof value.description === "string" ? value.description.trim().slice(0, 500) : ""
    if (!name) throw new Error("模板名称不能为空")
    if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 20) {
      throw new Error("模板需要包含 1-20 个节点")
    }
    const ids = new Set<string>()
    const nodes = value.nodes.map((raw, index): WorkflowTemplateNodeDefinition => {
      if (!raw || typeof raw !== "object") throw new Error(`第 ${index + 1} 个节点无效`)
      const node = raw as Record<string, unknown>
      const id = typeof node.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(node.id) ? node.id : `node-${index + 1}`
      if (ids.has(id)) throw new Error(`节点 ID 重复: ${id}`)
      ids.add(id)
      const title = typeof node.title === "string" ? node.title.trim().slice(0, 80) : ""
      const agentId = typeof node.agentId === "string" ? node.agentId : ""
      if (!title) throw new Error(`第 ${index + 1} 个节点缺少标题`)
      if (!this.agentRegistry.get(agentId)) throw new Error(`Agent 不存在: ${agentId}`)
      const prompt = typeof node.prompt === "string" ? node.prompt.trim().slice(0, 10_000) : ""
      const dependsOn = Array.isArray(node.dependsOn)
        ? [...new Set(node.dependsOn.filter((item): item is string => typeof item === "string"))]
        : []
      const rawCondition = node.condition && typeof node.condition === "object"
        ? node.condition as Record<string, unknown> : null
      let condition: WorkflowNodeCondition | undefined
      if (rawCondition) {
        if (typeof rawCondition.nodeId !== "string" || !["contains", "not-contains", "equals"].includes(String(rawCondition.operator))) {
          throw new Error(`第 ${index + 1} 个节点的执行条件无效`)
        }
        if (typeof rawCondition.value !== "string" || !rawCondition.value.trim()) {
          throw new Error(`第 ${index + 1} 个节点的条件匹配文本不能为空`)
        }
        condition = {
          nodeId: rawCondition.nodeId,
          operator: rawCondition.operator as WorkflowNodeCondition["operator"],
          value: rawCondition.value.trim().slice(0, 500),
        }
      }
      const resourceClaims = normalizeResourceClaims({
        reads: Array.isArray(node.readTargets) ? node.readTargets as string[] : [],
        writes: Array.isArray(node.writeTargets) ? node.writeTargets as string[] : [],
      }, ".")
      return { id, title, agentId, prompt, dependsOn, condition, resourceClaims }
    })
    for (const node of nodes) {
      if (node.dependsOn.includes(node.id)) throw new Error(`节点不能依赖自身: ${node.title}`)
      for (const dependency of node.dependsOn) if (!ids.has(dependency)) throw new Error(`依赖节点不存在: ${dependency}`)
      if (node.condition && !ids.has(node.condition.nodeId)) throw new Error(`条件节点不存在: ${node.condition.nodeId}`)
      if (node.condition && !node.dependsOn.includes(node.condition.nodeId)) {
        throw new Error(`条件来源必须是直接依赖节点: ${node.title}`)
      }
    }
    assertAcyclic(nodes)
    const failurePolicy = normalizeFailurePolicy(value.failurePolicy && typeof value.failurePolicy === "object"
      ? value.failurePolicy as WorkflowFailurePolicy : undefined)
    return { name, description, nodes, failurePolicy }
  }

  private requireRun(workflowId: string): WorkflowRunView {
    const run = WorkflowRepo.get(workflowId)
    if (!run) throw new Error("工作流不存在")
    return run
  }

  private registerRunGraph(run: WorkflowRunView): void {
    runGraphService.ensureRoot({
      id: run.id,
      sessionId: run.sessionId,
      objective: run.goal,
      agentId: "main-agent",
      status: "queued",
    })
  }

  private transitionGraph(
    workflowId: string,
    status: "running" | "waiting" | "completed" | "failed" | "cancelled",
  ): void {
    const nodeStatus: RunNodeStatus = status === "completed" ? "accepted"
      : status === "waiting" ? "blocked"
      : status
    const node = RunGraphRepo.getNode(workflowId)
    if (!node) throw new Error(`工作流 RunGraph 根节点不存在: ${workflowId}`)
    if (node.status === nodeStatus && RunGraphRepo.get(workflowId)?.status === status) return
    RunGraphRepo.updateNode(workflowId, { status: nodeStatus })
    RunGraphRepo.updateStatus(workflowId, status)
    RunGraphRepo.appendEvent(workflowId, "workflow-status", { status, nodeStatus })
  }

  private nodeResourceClaims(node: WorkflowNodeView, workingDir: string) {
    const explicit = normalizeResourceClaims(node.resourceClaims, workingDir)
    if (explicit.writes.length > 0) return explicit
    const agent = this.agentRegistry.get(node.agentId)
    const canMutate = agent?.tools.some((name) =>
      this.toolRegistry.get(name)?.contract.effects.includes("workspace-write")) === true
    return canMutate ? { reads: explicit.reads, writes: ["workspace:**"] } : explicit
  }

  private async runDueSchedules(): Promise<void> {
    if (this.scheduleTicking) return
    this.scheduleTicking = true
    try {
      for (const schedule of WorkflowScheduleRepo.listDue()) {
        try { await this.launchSchedule(schedule, Date.now()) }
        catch (error) { console.error(`[workflow] 定时计划 ${schedule.id} 启动失败:`, error) }
      }
    } finally { this.scheduleTicking = false }
  }

  private async launchSchedule(schedule: WorkflowScheduleView, now: number): Promise<WorkflowRunView> {
    const run = this.create({
      sessionId: schedule.sessionId, templateId: schedule.templateId,
      goal: schedule.goal, workingDir: schedule.workingDir,
    })
    const nextRunAt = schedule.frequency === "interval"
      ? now + Math.max(1, schedule.intervalMinutes ?? 60) * 60_000
      : schedule.nextRunAt
    WorkflowScheduleRepo.update(schedule.id, {
      lastRunAt: now, lastWorkflowId: run.id, nextRunAt,
      enabled: schedule.frequency === "interval",
    })
    return this.start(run.id)
  }
}

export function buildWorkflowReport(run: WorkflowRunView, runtimeError?: string): string {
  const lines = [
    `# 工作流报告`, "", `目标：${run.goal}`, `状态：${workflowStatusLabel(run.status)}`, "",
    "| 阶段 | 状态 | 耗时 |", "| --- | --- | --- |",
  ]
  for (const node of run.nodes) {
    lines.push(`| ${node.ordinal + 1}. ${node.title} | ${nodeStatusLabel(node.status)} | ${duration(node.startedAt, node.completedAt)} |`)
  }
  if (runtimeError || run.nodes.some((node) => node.error)) {
    lines.push("", "部分阶段需要处理。具体原因由主 Agent 核验后统一说明。")
  }
  if (run.status === "completed") {
    lines.push("", "所有阶段均已通过运行时完成门，最终成果由主 Agent 验收后交付。")
  }
  return lines.join("\n")
}

export function readyNodes(run: WorkflowRunView): WorkflowNodeView[] {
  const completed = new Set(run.nodes.filter((node) => ["completed", "skipped"].includes(node.status)).map((node) => node.id))
  return run.nodes.filter((node) => node.status === "pending"
    && node.dependsOn.every((id) => completed.has(id))
    && conditionMatches(run, node.condition)).slice(0, 3)
}

export function skippableNodes(run: WorkflowRunView): WorkflowNodeView[] {
  const completed = new Set(run.nodes.filter((node) => ["completed", "skipped"].includes(node.status)).map((node) => node.id))
  return run.nodes.filter((node) => node.status === "pending" && Boolean(node.condition)
    && node.dependsOn.every((id) => completed.has(id))
    && !conditionMatches(run, node.condition))
}

export function conditionMatches(run: WorkflowRunView, condition?: WorkflowNodeCondition): boolean {
  if (!condition) return true
  const source = run.nodes.find((node) => node.id === condition.nodeId)
  const actual = source?.result?.trim() ?? ""
  const expected = condition.value.trim()
  if (condition.operator === "equals") return actual === expected
  const normalizedActual = actual.toLocaleLowerCase()
  const normalizedExpected = expected.toLocaleLowerCase()
  return condition.operator === "contains"
    ? normalizedActual.includes(normalizedExpected)
    : !normalizedActual.includes(normalizedExpected)
}

function completedContext(run: WorkflowRunView, target: WorkflowNodeView): string {
  const byId = new Map(run.nodes.map((node) => [node.id, node]))
  const dependencyIds = new Set<string>()
  const visit = (id: string) => {
    if (dependencyIds.has(id)) return
    dependencyIds.add(id)
    for (const parent of byId.get(id)?.dependsOn ?? []) visit(parent)
  }
  for (const dependency of target.dependsOn) visit(dependency)
  const completed = run.nodes.filter((node) => dependencyIds.has(node.id) && node.status === "completed" && node.result)
  if (completed.length === 0) return `工作流总目标：${run.goal}`
  return [
    `工作流总目标：${run.goal}`,
    "以下是前序节点的已确认结果，请以此为上下文继续执行：",
    ...completed.map((node) => `\n### ${node.title}\n${node.result}`),
  ].join("\n")
}

function buildNodePrompt(goal: string, agentName: string, step: number, total: number, customPrompt = "", nodeTitle = agentName): string {
  return [
    `你正在执行一个持久化多 Agent 工作流的第 ${step}/${total} 步。`,
    `总目标：${goal}`,
    `当前节点：${nodeTitle}。`,
    `当前职责：作为${agentName}，完成你负责的分析、实施或验证。`,
    customPrompt ? `节点要求：${customPrompt}` : "",
    "请基于工作区真实状态和前序节点结果执行，不要假设未验证的结果。结尾给出完成内容、证据和后续节点需要知道的约束。",
  ].filter(Boolean).join("\n")
}

export function descendantNodeIds(run: WorkflowRunView, rootId: string): Set<string> {
  const result = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const node of run.nodes) {
      if (!result.has(node.id) && node.dependsOn.some((id) => result.has(id))) {
        result.add(node.id)
        changed = true
      }
    }
  }
  return result
}

/**
 * Execute one ready DAG layer under an explicit sibling-failure policy.
 * fail-fast requests cancellation on the first rejection but still joins all
 * siblings, so callers never publish a terminal workflow while a sibling is
 * still mutating the workspace. continue simply joins the complete layer.
 */
export async function settleWorkflowSiblings(
  executions: Promise<void>[],
  policy: "fail-fast" | "continue",
  onFailFast: (error: unknown) => void,
): Promise<PromiseSettledResult<void>[]> {
  if (policy === "continue") return Promise.allSettled(executions)
  let cancellationRequested = false
  const guarded = executions.map((execution) => execution.catch((error) => {
    if (!cancellationRequested) {
      cancellationRequested = true
      onFailFast(error)
    }
    throw error
  }))
  return Promise.allSettled(guarded)
}

export function assertAcyclic(nodes: WorkflowTemplateNodeDefinition[]): void {
  const indegree = new Map(nodes.map((node) => [node.id, node.dependsOn.length]))
  const queue = nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    visited++
    for (const node of nodes.filter((item) => item.dependsOn.includes(id))) {
      const next = (indegree.get(node.id) ?? 0) - 1
      indegree.set(node.id, next)
      if (next === 0) queue.push(node.id)
    }
  }
  if (visited !== nodes.length) throw new Error("工作流依赖存在循环")
}

function actionKey(workflowId: string, nodeId: string): string { return `${workflowId}:${nodeId}` }

function duration(start?: number, end?: number): string {
  if (!start) return "-"
  const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

function workflowStatusLabel(status: WorkflowRunView["status"]): string {
  return ({ planned: "待开始", running: "运行中", pausing: "暂停中", cancelling: "取消中", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消" })[status]
}

function nodeStatusLabel(status: WorkflowNodeView["status"]): string {
  return ({ pending: "待执行", queued: "排队中", running: "运行中", "safety-quarantine": "工作区安全隔离", completed: "已完成", failed: "失败", skipped: "已跳过", "waiting-human": "人工接管", paused: "已暂停", cancelled: "已取消" })[status]
}

function abortError(): Error {
  const error = new Error("工作流节点已中断")
  error.name = "AbortError"
  return error
}
