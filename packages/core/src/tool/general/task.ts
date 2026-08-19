import { defineTool } from "../define"
import { AgentLoop } from "../../runtime/agent-loop"
import {
  allocateDelegatedExecutionLease,
  DEFAULT_EXECUTION_BUDGET_POLICY,
} from "../../runtime/execution-budget.ts"
import { taskScheduler } from "../../runtime/task-scheduler.ts"
import { logOrchestrationEvent } from "../../runtime/orchestration-log.ts"
import {
  normalizeTaskContract,
  renderTaskContract,
  type TaskContract,
} from "../../runtime/run-contract.ts"
import { RunContractRepo } from "../../store/run-contract.ts"
import { executeAgentRun, type RunExecutorResult } from "../../runtime/run-executor.ts"
import { runGraphService } from "../../runtime/run-graph.ts"
import { workspaceRevisionService } from "../../runtime/workspace-revision.ts"
import {
  buildStructuredTaskResult,
  settleCompletedTask,
} from "../../runtime/task-settlement.ts"
import { MAIN_AGENT_ID } from "../../agent/definitions/main-agent.ts"
import { unsupportedTaskEffects } from "../../runtime/task-capability.ts"
import {
  assertPlanNodeInvocationMatches,
  instantiatePlannedTaskContract,
  resolveExecutablePlanNode,
} from "../../runtime/executable-plan.ts"
import type { ToolEffect, ToolEvidenceAttestation } from "../types.ts"
import {
  awaitCooperativeWorkerExit,
  bridgeSubAgentEvent,
  childToolActivity,
  childToolState,
  delegatedTaskBudgetUnavailable,
  delegatedTaskFailure,
  delegatedTaskLeaseExpired,
  failScheduledChild,
  finalizeDetachedWorkerExit,
  logDelegationTerminal,
  logStructuredResultPersisted,
  persistTaskResult,
  resumeParentAfterDelegation,
  resolveDelegatedModelRoute,
  rollbackOrRetainForSafety,
  rootRunId,
  WorkerExitPendingError,
} from "./task-delegation-runtime.ts"

export {
  awaitCooperativeWorkerExit,
  bridgeSubAgentEvent,
  resolveDelegatedExecutionDeadline,
  resolveDelegatedModelRoute,
  WorkerExitPendingError,
} from "./task-delegation-runtime.ts"

const MAX_DEPTH = 3
const CHILD_MAX_STEPS = 12

export const taskTool = defineTool({
  name: "task",
  description: `启动一个已注册的子 Agent 处理独立的复杂任务。
模型只提交角色、任务摘要和具体指令；运行时负责权限继承、调度、取消、超时、结果持久化和完成判定。
明确的单文件读取或搜索应直接使用对应工具，不要为了制造流程而委派。`,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      subagent_name: { type: "string", description: "要启动的子 Agent 名称（如 general / explore / debug-engineer）" },
      description: { type: "string", description: "子 Agent 要执行的任务描述" },
      prompt: { type: "string", description: "子 Agent 的具体指令" },
    },
    required: ["subagent_name", "description", "prompt"],
  },
  async execute({
    subagent_name, description, prompt, constraints, acceptance, acceptance_criteria, input_artifacts,
    expected_outputs, required_effects, read_targets, write_targets,
    plan_id, plan_version, plan_node_id,
  }: any, ctx) {
    if (ctx.runType !== "root" || ctx.agentId !== MAIN_AGENT_ID) {
      return { success: false, error: "只有主 Agent 的根运行可以创建子 Agent；子 Agent 之间必须通过主 Agent 同步" }
    }
    const parentRunId = ctx.runId ?? ctx.sessionId
    logOrchestrationEvent({
      sessionId: ctx.sessionId,
      runId: parentRunId,
      agentId: ctx.agentId,
      eventType: "delegation.requested",
      message: "主 Agent 请求委派子任务",
      data: { targetAgentId: subagent_name, description, depth: ctx.__depth ?? 0 },
    })
    if (!ctx.agentRegistry || !ctx.toolRegistry || !ctx.modelRouter) {
      return { success: false, error: "子Agent委派需要 AgentRegistry/ToolRegistry/ModelRouter 注入" }
    }

    const suppliedPlanReference = plan_id !== undefined
      || plan_version !== undefined
      || plan_node_id !== undefined
    if (!ctx.activePlan && suppliedPlanReference) {
      return { success: false, error: "当前运行没有已批准的权威计划，禁止提交悬空计划引用" }
    }
    let plannedNode: ReturnType<typeof resolveExecutablePlanNode> | undefined
    if (ctx.activePlan && suppliedPlanReference) {
      if (typeof plan_id !== "string"
        || !Number.isSafeInteger(plan_version)
        || typeof plan_node_id !== "string") {
        return {
          success: false,
          error: "当前运行存在权威计划；task 必须同时引用 plan_id、plan_version、plan_node_id",
        }
      }
      try {
        plannedNode = resolveExecutablePlanNode(ctx.activePlan, {
          planId: plan_id,
          version: plan_version,
          nodeId: plan_node_id,
        })
        assertPlanNodeInvocationMatches({
          node: plannedNode,
          subagent: subagent_name,
          requiredEffects: required_effects,
          reads: read_targets,
          writes: write_targets,
          acceptance,
          expectedOutputs: expected_outputs,
        })
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
      subagent_name = plannedNode.assigneeAgentId
      description = plannedNode.taskContract.objective
    }

    // 递归深度防护：子 Agent 不可无限委派子 Agent
    const depth = ctx.__depth ?? 0
    if (depth >= MAX_DEPTH) {
      return { success: false, error: `子 Agent 委派深度已达上限 (${MAX_DEPTH})，拒绝继续递归` }
    }

    // 查找子Agent定义
    const subAgentDef = ctx.agentRegistry.get(subagent_name)
    if (!subAgentDef) {
      return {
        success: false,
        error: `子Agent "${subagent_name}" 未找到。可用: ${ctx.agentRegistry.list().map(a => a.id).join(", ")}`,
      }
    }
    if (subAgentDef.mode === "primary") {
      return { success: false, error: "主 Agent 是根任务 owner，不能作为子 Agent 启动" }
    }
    const budget = {
      ...DEFAULT_EXECUTION_BUDGET_POLICY,
      ...ctx.executionBudget,
    }
    let contract: TaskContract
    if (plannedNode && ctx.activePlan) {
      const plannedContract = instantiatePlannedTaskContract({
          plan: ctx.activePlan,
          reference: {
            planId: plan_id,
            version: plan_version,
            nodeId: plan_node_id,
          },
          workingDir: ctx.workingDir,
          inputArtifacts: Array.isArray(input_artifacts) ? input_artifacts : [],
        })
      contract = plannedContract
    } else {
      const proposedContract = {
          objective: description,
          instructions: prompt,
          constraints,
          acceptance,
          acceptanceCriteria: acceptance_criteria,
          inputArtifacts: input_artifacts,
          expectedOutputs: expected_outputs,
          requiredEffects: required_effects as ToolEffect[] | undefined,
          resources: { reads: read_targets, writes: write_targets },
        }
      contract = normalizeTaskContract(proposedContract, ctx.workingDir)
    }
    const unsupportedEffects = unsupportedTaskEffects({
      agent: subAgentDef,
      tools: ctx.toolRegistry,
      requiredEffects: contract.requiredEffects,
      scope: ctx.scope ?? "auto-edit",
      policy: ctx.toolPolicy,
      workingDir: ctx.workingDir,
    })
    if (unsupportedEffects.length > 0) {
      return {
        success: false,
        error: `子 Agent "${subAgentDef.id}" 无法满足原子任务工具效果：${unsupportedEffects.join(", ")}`,
        outcome: {
          status: "failed",
          category: "generic",
          summary: "原子任务能力预检失败，父任务尚未让出所有权",
          fingerprint: `task-capability:${subAgentDef.id}:${unsupportedEffects.sort().join(",")}`,
          diagnostic: {
            kind: "atomic-task-capability-mismatch",
            evidence: contract.requiredEffects.map((effect) => `required:${effect}`),
            nextActions: ["主 Agent 重新拆分任务或选择具备所需工具效果的专业角色"],
            retryable: false,
            failureDisposition: "continue",
          },
        },
      }
    }
    // 创建子AgentLoop（限制步数，防止无限循环）
    const subLoop = new AgentLoop({
      toolRegistry: ctx.toolRegistry,
      agentRegistry: ctx.agentRegistry,
      modelRouter: ctx.modelRouter,
    }, CHILD_MAX_STEPS)

    // Allocate the child lease before changing scheduler state. An unavailable
    // lease must leave the parent running and must not create a zombie child.
    const rootDeadline = ctx.executionDeadline ?? Date.now() + budget.rootWindowMs
    const lease = allocateDelegatedExecutionLease(rootDeadline, budget, Date.now(), {
      predictedP90Ms: Math.round(budget.childLeaseMs * 0.55),
      verificationReserveMs: Math.round(budget.childLeaseMs * 0.10),
      acceptanceCount: contract.acceptance.length,
      dependencyCount: contract.inputArtifacts.length,
      resourceCount: contract.resources.reads.length + contract.resources.writes.length,
      priorRevisions: 0,
    })
    if (!lease) {
      return delegatedTaskBudgetUnavailable(subagent_name, description, rootDeadline - Date.now())
    }

    // 子任务必须和根任务一样进入统一调度器；禁止直接启动未纳管的 AgentLoop。
    const childAbort = new AbortController()
    let scheduledChild: ReturnType<typeof taskScheduler.enqueue>
    try {
      scheduledChild = taskScheduler.enqueue({
        parentRunId,
        sessionId: ctx.sessionId,
        agentId: subAgentDef.id,
        priority: 8,
        type: "background",
        message: description,
        workingDir: ctx.workingDir,
        scope: ctx.scope,
        modelId: ctx.preferredModelId,
        laneKey: `conversation:${ctx.sessionId}`,
        laneOwner: rootRunId(ctx),
        resourceClaims: contract.resources,
        onCancel: () => childAbort.abort(),
      })
    } catch (error) {
      return {
        success: false,
        error: `无法创建子任务: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const runId = scheduledChild.id
    ctx.delegationGroup?.onChildScheduled(runId)
    contract.logicalTaskId ??= runId
    contract.attempt ??= 1
    const childIdentity = buildChildRunIdentity(ctx, runId)
    const collected: string[] = []
    let workerExitFinalizerOwnsLease = false
    try {
      RunContractRepo.create({
        runId, sessionId: ctx.sessionId, parentRunId,
        agentId: subAgentDef.id, contract,
      })
      runGraphService.bindContract(runId, contract)
      if (contract.resources.writes.length > 0) {
        workspaceRevisionService.open(runId, ctx.workingDir)
      }
      logOrchestrationEvent({
        sessionId: ctx.sessionId,
        runId,
        parentRunId,
        agentId: subAgentDef.id,
        eventType: "delegation.contract-created",
        message: "子任务结构化契约已持久化",
        data: {
          objective: contract.objective,
          acceptanceCount: contract.acceptance.length,
          inputArtifactCount: contract.inputArtifacts.length,
          expectedOutputCount: contract.expectedOutputs.length,
          resourceClaims: contract.resources,
        },
      })
    } catch (error) {
      taskScheduler.cancel(runId)
      return { success: false, error: `无法持久化子任务契约: ${error instanceof Error ? error.message : String(error)}` }
    }

    // Only a durable child with a valid contract may suspend its parent.
    const parentSuspended = ctx.delegationGroup?.parentGateOwned
      ? false
      : taskScheduler.waitForDelegation(parentRunId, `等待子任务：${description}`)
    if (!ctx.delegationGroup?.parentGateOwned && !parentSuspended) {
      taskScheduler.cancel(runId)
      taskScheduler.confirmWorkerExit(runId, "父任务未进入 waiting-delegation，子任务未启动")
      return {
        success: false,
        error: "主 Agent 未进入 waiting-delegation，拒绝启动无 owner 的子任务",
      }
    }
    const resumeParent = () => resumeParentAfterDelegation(parentRunId, parentSuspended, ctx.abortSignal)

    try {
    const report = (state: import("../types").AgentActivityState, activity: string, toolName?: string) => {
      logOrchestrationEvent({
        sessionId: ctx.sessionId, runId, parentRunId, agentId: subAgentDef.id,
        eventType: "delegation.activity", level: "debug",
        message: activity, data: { state, toolName },
      })
    }
    report("queued", `接到任务：${description}`)

    const deadline = lease.deadline
    const initialRemainingMs = deadline - Date.now()
    if (initialRemainingMs <= 0) {
      taskScheduler.cancel(runId)
      persistTaskResult(ctx, runId, "interrupted", "子任务执行租约在启动前已到期", collected)
      logDelegationTerminal(ctx, runId, subAgentDef.id, "delegation.interrupted", "子任务执行租约在启动前已到期")
      await resumeParent()
      return delegatedTaskLeaseExpired(subagent_name, description, collected, lease)
    }
    const timeoutSignal = AbortSignal.timeout(initialRemainingMs)
    const signal = AbortSignal.any([
      childAbort.signal,
      timeoutSignal,
      ...(ctx.abortSignal ? [ctx.abortSignal] : []),
    ])
    try {
      await taskScheduler.waitForTurn(runId, signal)
    } catch {
      const leaseExpired = timeoutSignal.aborted
      const reason = leaseExpired ? "子任务在排队期间租约已到期" : "子任务在获得调度权前被取消"
      persistTaskResult(ctx, runId, leaseExpired ? "interrupted" : "cancelled", reason, collected)
      logDelegationTerminal(ctx, runId, subAgentDef.id, "delegation.interrupted", reason)
      await resumeParent()
      if (leaseExpired) return delegatedTaskLeaseExpired(subagent_name, description, collected, lease)
      return delegatedTaskFailure(subagent_name, description, "子任务在获得调度权前被取消", collected, "delegation-cancelled")
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0 || timeoutSignal.aborted) {
      taskScheduler.cancel(runId)
      persistTaskResult(ctx, runId, "interrupted", "子任务获得调度权时租约已到期", collected)
      logDelegationTerminal(ctx, runId, subAgentDef.id, "delegation.interrupted", "子任务获得调度权时租约已到期")
      await resumeParent()
      return delegatedTaskLeaseExpired(subagent_name, description, collected, lease)
    }
    logOrchestrationEvent({
      sessionId: ctx.sessionId,
      runId,
      parentRunId,
      agentId: subAgentDef.id,
      eventType: "delegation.started",
      message: "子 Agent 已获得统一调度权",
      data: { description, depth: depth + 1, leaseMs: lease.leaseMs, parentReserveMs: lease.parentReserveMs },
    })
    const childRoute = resolveDelegatedModelRoute(ctx, subAgentDef.id)
    const collect = executeAgentRun({
      loop: subLoop,
      run: {
        ...childIdentity,
        userMessage: renderTaskContract(contract),
        agentId: subagent_name,
        workingDir: ctx.workingDir,
        history: [],
        scope: ctx.scope,
        abortSignal: signal,
        toolPolicy: ctx.toolPolicy,
        resourceClaims: contract.resources,
        searchConfig: ctx.searchConfig,
        preferredModelId: childRoute.preferredModelId,
        agentModelRoutes: ctx.agentModelRoutes,
        modelFallbackEnabled: ctx.modelFallbackEnabled,
        fallbackModelIds: childRoute.fallbackModelIds,
        maxStepsOverride: CHILD_MAX_STEPS,
        executionDeadline: deadline,
        executionBudget: budget,
        executionGate: {
          suspendForApproval: (reason: string) => taskScheduler.waitForApproval(runId, reason),
          resumeAfterApproval: () => taskScheduler.resumeTaskAndWait(runId, signal),
        },
        onSubAgentInteraction: ctx.onSubAgentInteraction,
        __depth: depth + 1,
        activityOutput: undefined,
      } as any,
      onEvent: (event) => {
        if (event.type === "text-delta") {
          collected.push(event.text)
          report("thinking", "站在白板前整理阶段性成果")
        } else if (event.type === "thinking-start") {
          report("thinking", "站在白板前思考任务方案")
        } else if (bridgeSubAgentEvent(event, ctx)) {
          // 已桥接到父 Agent 的实时通道。
        } else if (event.type === "tool-status" && event.status === "running") {
          const state = childToolState(event.name)
          report(state, childToolActivity(event.name), event.name)
        }
      },
    })

    let executionResult: RunExecutorResult
    try {
      report("collaborating", "进入协作工位")
      executionResult = await awaitCooperativeWorkerExit(collect, signal, 5_000)
    } catch (err: any) {
      report("failed", `任务异常：${err.message}`)
      const resultStatus = timeoutSignal.aborted ? "interrupted" : "failed"
      persistTaskResult(ctx, runId, resultStatus, err.message, collected)
      if (err instanceof WorkerExitPendingError) {
        // The worker did not honor cooperative cancellation. Keep the
        // scheduler lease in "cancelling" until the actual promise settles;
        // only that settlement may release resources and roll back writes.
        workerExitFinalizerOwnsLease = true
        taskScheduler.cancel(runId)
        finalizeDetachedWorkerExit(collect, runId, ctx, subAgentDef.id)
        logDelegationTerminal(
          ctx,
          runId,
          subAgentDef.id,
          "delegation.worker-exit-pending",
          "取消已请求，资源租约保留到 Worker 真实退出",
        )
        await resumeParent()
        if (timeoutSignal.aborted) {
          return delegatedTaskLeaseExpired(subagent_name, description, collected, lease)
        }
        return delegatedTaskFailure(
          subagent_name,
          description,
          "子任务已取消，非协作 Worker 正在退出；资源租约仍被保留",
          collected,
          "delegation-worker-exit-pending",
        )
      }
      const retained = rollbackOrRetainForSafety(
        ctx, runId, subAgentDef.id, description, contract.resources.writes.length > 0, err.message, collected,
      )
      if (retained) {
        await resumeParent()
        return retained
      }
      failScheduledChild(runId, err.message)
      if (timeoutSignal.aborted) {
        logDelegationTerminal(ctx, runId, subAgentDef.id, "delegation.interrupted", "子任务执行租约已到期")
        await resumeParent()
        return delegatedTaskLeaseExpired(subagent_name, description, collected, lease)
      }
      logDelegationTerminal(ctx, runId, subAgentDef.id, "delegation.failed", err.message)
      await resumeParent()
      return delegatedTaskFailure(subagent_name, description, err.message, collected)
    }

    if (timeoutSignal.aborted) {
      report("failed", "子任务执行租约已到期，返回阶段性成果")
      persistTaskResult(ctx, runId, "interrupted", "子任务执行租约已到期", collected)
      const retained = rollbackOrRetainForSafety(
        ctx, runId, subAgentDef.id, description, contract.resources.writes.length > 0,
        "子任务执行租约已到期", collected,
      )
      if (retained) {
        await resumeParent()
        return retained
      }
      failScheduledChild(runId, "子任务执行租约已到期")
      logDelegationTerminal(ctx, runId, subAgentDef.id, "delegation.interrupted", "子任务执行租约已到期")
      await resumeParent()
      return delegatedTaskLeaseExpired(subagent_name, description, collected, lease)
    }
    const terminal = executionResult.terminal
    if (terminal.status !== "completed") {
      const reason = terminal.reason
      report("failed", `任务未完成：${reason}`)
      persistTaskResult(ctx, runId, terminal.status === "blocked" ? "blocked" : "interrupted", reason, collected)
      const retained = rollbackOrRetainForSafety(
        ctx, runId, subAgentDef.id, description, contract.resources.writes.length > 0, reason, collected,
      )
      if (retained) {
        await resumeParent()
        return retained
      }
      failScheduledChild(runId, reason)
      logDelegationTerminal(
        ctx, runId, subAgentDef.id,
        terminal.status === "blocked" ? "delegation.blocked" : "delegation.interrupted",
        reason,
      )
      await resumeParent()
      return delegatedTaskFailure(
        subagent_name,
        description,
        reason,
        collected,
        terminal.status === "blocked" ? "delegation-blocked" : "delegation-interrupted",
      )
    }

    const result = collected.join("").trim()
    if (!result) {
      report("failed", "未返回有效结果")
      persistTaskResult(ctx, runId, "failed", "子 Agent 未返回有效结果", collected)
      const retained = rollbackOrRetainForSafety(
        ctx, runId, subAgentDef.id, description, contract.resources.writes.length > 0,
        "子 Agent 未返回有效结果", collected,
      )
      if (retained) {
        await resumeParent()
        return retained
      }
      failScheduledChild(runId, "子 Agent 未返回有效结果")
      logDelegationTerminal(ctx, runId, subAgentDef.id, "delegation.failed", "子 Agent 未返回有效结果")
      await resumeParent()
      return { success: false, error: `子Agent "${subagent_name}" 未返回有效结果` }
    }

    report("completed", "任务执行结束，正在向主 Agent 返回结果")
    const structuredResult = buildStructuredTaskResult({
      runId,
      sessionId: ctx.sessionId,
      status: "completed",
      summary: "子 Agent 已完成当前执行轮次",
      output: collected.join(""),
    })
    if (!await settleCompletedTask({
      runId,
      sessionId: ctx.sessionId,
      result: structuredResult,
      resultText: result,
    })) {
      try {
        workspaceRevisionService.rollback(runId, ctx.sessionId)
      } catch (error) {
        taskScheduler.quarantineForSafety(
          runId,
          `过期结果已拒绝，但工作区自动回滚未完成：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      logDelegationTerminal(ctx, runId, subAgentDef.id, "delegation.interrupted", "子任务结果提交时调度状态已变化")
      await resumeParent()
      return delegatedTaskFailure(
        subagent_name,
        description,
        "子任务结果提交时调度状态已变化，已拒绝过期结果",
        collected,
        "delegation-state-conflict",
      )
    }
    if (!taskScheduler.adoptCompletedSettlement(runId, result)) {
      throw new Error(`子任务完成结算的内存投影失败: ${runId}`)
    }
    logStructuredResultPersisted(ctx, runId, structuredResult)
    logOrchestrationEvent({
      sessionId: ctx.sessionId,
      runId,
      parentRunId,
      agentId: subAgentDef.id,
      eventType: "delegation.settled",
      message: "子 Agent 结果已结算并返回主 Agent",
      data: {
        description, resultChars: result.length, truncated: result.length > 5_000,
        logicalTaskId: contract.logicalTaskId, attempt: contract.attempt,
      },
    })
    await resumeParent()

    return {
      success: true,
      data: {
        runId,
        status: "completed",
        logicalTaskId: contract.logicalTaskId,
        attempt: contract.attempt,
        subagent: subagent_name,
        description,
        result: result.slice(0, 5000),
        truncated: result.length > 5000,
        resultRef: `run-result:${runId}`,
        artifacts: structuredResult.artifacts,
        evidence: structuredResult.evidence,
        unresolved: structuredResult.unresolved,
      },
      outcome: {
        status: "succeeded",
        category: "evidence",
        summary: "Delegated work completed and returned to the main Agent",
        evidence: promoteDelegatedEvidence(structuredResult, runId),
      },
    }
    } finally {
      // This is the owner-handoff safety net. Any unexpected exception between
      // parent suspension and a normal child terminal transition must neither
      // strand the parent nor leave an unowned writer holding a live slot.
      if (!workerExitFinalizerOwnsLease) {
        const orphan = taskScheduler.getTask(runId)
        if (orphan?.status === "cancelling") {
          taskScheduler.confirmWorkerExit(runId, "子 Agent 执行体已退出")
        } else if (orphan && ["queued", "running", "waiting-approval"].includes(orphan.status)) {
          persistTaskResult(ctx, runId, "failed", "子任务执行边界异常退出，已由主 Agent 接管", collected)
          let rollbackComplete = true
          if (contract.resources.writes.length > 0) {
            try { workspaceRevisionService.rollback(runId, ctx.sessionId) }
            catch { rollbackComplete = false }
          }
          if (!rollbackComplete && taskScheduler.quarantineForSafety(
            runId,
            "子任务执行边界异常退出，且工作区自动回滚未完成",
          )) {
            logDelegationTerminal(
              ctx, runId, subAgentDef.id, "delegation.rollback-safety-quarantined",
              "子任务执行边界异常退出，工作区已隔离等待主 Agent 处理",
            )
          } else {
            failScheduledChild(runId, "子任务执行边界异常退出")
            logDelegationTerminal(
              ctx, runId, subAgentDef.id, "delegation.failed",
              "子任务执行边界异常退出，父任务已恢复",
            )
          }
        }
      }
      await resumeParent()
    }
  },
  contract: {
    effects: ["delegation"],
    runtimeDependencies: { modelCapabilities: ["chat"] },
    idempotency: "non-idempotent",
    cancellation: "cooperative",
    progress: { role: "delegation" },
  },
  permission: "task",
})

function promoteDelegatedEvidence(
  result: ReturnType<typeof buildStructuredTaskResult>,
  runId: string,
): ToolEvidenceAttestation[] {
  const promoted = new Map<string, ToolEvidenceAttestation>()
  for (const reference of [...result.evidence, ...result.artifacts]) {
    for (const kind of reference.evidenceKinds ?? []) {
      const targets = [...new Set([reference.ref, ...(reference.targets ?? [])])]
      const evidence = { kind, targets, producer: `task:${runId}` } as ToolEvidenceAttestation
      promoted.set(`${kind}\u0000${targets.join("\u0000")}`, evidence)
    }
  }
  return [...promoted.values()]
}

export function buildChildRunIdentity(
  ctx: Pick<import("../types").ToolContext, "sessionId" | "permissionContextId" | "runId">,
  childRunId: string,
): { runId: string; parentRunId: string; runType: "subagent"; checkpointKey: string; sessionId: string; permissionContextId: string } {
  return {
    runId: childRunId,
    parentRunId: ctx.runId ?? ctx.sessionId,
    runType: "subagent",
    checkpointKey: childRunId,
    sessionId: ctx.sessionId,
    permissionContextId: ctx.permissionContextId ?? ctx.sessionId,
  }
}
