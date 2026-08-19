import { buildStructuredTaskResult } from "../../runtime/task-settlement.ts"
import {
  allocateDelegatedExecutionLease,
  DEFAULT_EXECUTION_BUDGET_POLICY,
  type DelegatedExecutionLease,
  type ExecutionBudgetPolicy,
} from "../../runtime/execution-budget.ts"
import { logOrchestrationEvent } from "../../runtime/orchestration-log.ts"
import type { RunExecutorResult } from "../../runtime/run-executor.ts"
import {
  artifactReferencesFromExecutions,
  evidenceReferencesFromExecutions,
  type TaskResultStatus,
} from "../../runtime/run-contract.ts"
import { taskScheduler } from "../../runtime/task-scheduler.ts"
import { workspaceRevisionService } from "../../runtime/workspace-revision.ts"
import { ExecutionRunRepo } from "../../store/execution-run.ts"
import { RunContractRepo } from "../../store/run-contract.ts"
import { ToolExecutionRepo } from "../../store/tool-execution.ts"
import type {
  AgentActivityState,
  ToolContext,
  ToolResult,
} from "../types.ts"

type DelegationContext = Pick<ToolContext, "sessionId" | "runId">

export function resolveDelegatedModelRoute(
  context: Pick<ToolContext, "agentModelRoutes" | "modelRouter" | "preferredModelId" | "fallbackModelIds">,
  agentId: string,
): { preferredModelId?: string; fallbackModelIds?: string[] } {
  const route = context.agentModelRoutes?.[agentId]
  if (!route) return {
    preferredModelId: context.preferredModelId,
    fallbackModelIds: context.fallbackModelIds,
  }
  return {
    preferredModelId: route.primaryModelId && context.modelRouter?.getModel(route.primaryModelId)
      ? route.primaryModelId
      : context.preferredModelId,
    fallbackModelIds: route.fallbackModelIds.filter((id) => Boolean(context.modelRouter?.getModel(id))),
  }
}

export function resolveDelegatedExecutionDeadline(
  parentDeadline: number | undefined,
  now = Date.now(),
  policy: ExecutionBudgetPolicy = DEFAULT_EXECUTION_BUDGET_POLICY,
): number {
  const rootDeadline = typeof parentDeadline === "number" && Number.isFinite(parentDeadline)
    ? parentDeadline
    : now + policy.rootWindowMs
  return allocateDelegatedExecutionLease(rootDeadline, policy, now)?.deadline ?? now
}

export function delegatedTaskLeaseExpired(
  subagent: string,
  description: string,
  collected: string[],
  lease: DelegatedExecutionLease,
): ToolResult {
  const summary = `子 Agent "${subagent}" 的执行租约已到期，父任务仍保留恢复与验收预算`
  return {
    success: false,
    error: summary,
    data: {
      subagent,
      description,
      partialResult: collected.join("").trim().slice(0, 5_000),
    },
    outcome: {
      status: "timed-out" as const,
      category: "generic" as const,
      summary,
      fingerprint: `delegation-lease-expired:${subagent}`,
      diagnostic: {
        kind: "delegation-lease-expired",
        evidence: [`子任务租约 ${lease.leaseMs}ms 已用尽；父任务保留约 ${lease.parentReserveMs}ms`],
        nextActions: [
          "父 Agent 立即根据部分成果接管当前步骤",
          "需要再次委派时缩小任务范围并给出明确验收条件",
        ],
        retryable: true,
        recoveryCandidates: [
          {
            id: "parent-takeover",
            summary: "主 Agent 使用子任务部分成果接管剩余工作",
            steps: [{
              instruction: "读取子任务已登记的部分成果和相关工作区证据，由主 Agent 直接继续当前步骤",
              effects: ["workspace-read"],
            }],
          },
          {
            id: "smaller-redelegation",
            summary: "把剩余工作缩小为可在新租约内验收的子任务",
            steps: [{
              instruction: "根据部分成果缩小任务范围、资源和验收条件后重新委派",
              tools: ["task"],
              effects: ["delegation"],
            }],
          },
        ],
      },
    },
  }
}

export function delegatedTaskBudgetUnavailable(
  subagent: string,
  description: string,
  remainingMs: number,
): ToolResult {
  const summary = `父任务剩余预算不足，未启动子 Agent "${subagent}"`
  return {
    success: false,
    error: summary,
    data: {
      subagent,
      description,
      rootRemainingMs: Math.max(0, remainingMs),
    },
    outcome: {
      status: "timed-out" as const,
      category: "generic" as const,
      summary,
      fingerprint: `delegation-budget-unavailable:${subagent}`,
      diagnostic: {
        kind: "delegation-budget-unavailable",
        evidence: ["剩余时间必须留给父任务完成恢复、验证和结果交付"],
        nextActions: ["父 Agent 不再委派，直接完成当前最关键的验收步骤"],
        retryable: true,
        recoveryCandidates: [{
          id: "parent-finishes-critical-step",
          summary: "父 Agent 使用剩余预算完成最关键验收",
          steps: [{
            instruction: "读取现有成果并由父 Agent 直接完成当前最关键的可验证步骤",
            effects: ["workspace-read"],
          }],
        }],
      },
    },
  }
}

export function delegatedTaskFailure(
  subagent: string,
  description: string,
  reason: string,
  collected: string[],
  kind = "delegation-failure",
): ToolResult {
  const summary = `子 Agent "${subagent}" 执行失败: ${reason}`
  return {
    success: false,
    error: summary,
    data: {
      subagent,
      description,
      partialResult: collected.join("").trim().slice(0, 5_000),
    },
    outcome: {
      status: "failed" as const,
      category: "generic" as const,
      summary,
      fingerprint: `delegation-failed:${subagent}:${reason}`.slice(0, 500),
      diagnostic: {
        kind,
        evidence: [reason.slice(0, 1_000)],
        nextActions: [
          "父 Agent 使用部分成果继续执行",
          "必要时把剩余工作拆成更小的可验证子任务",
        ],
        retryable: true,
        recoveryCandidates: [
          {
            id: "parent-recovery",
            summary: "父 Agent 接管失败子任务的剩余工作",
            steps: [{
              instruction: "读取子任务部分成果和失败证据，由父 Agent 直接继续并验证",
              effects: ["workspace-read"],
            }],
          },
          {
            id: "bounded-redelegation",
            summary: "缩小失败任务后重新委派",
            steps: [{
              instruction: "把剩余工作拆成更小且有明确验收条件的子任务后重新委派",
              tools: ["task"],
              effects: ["delegation"],
            }],
          },
        ],
      },
    },
  }
}

export function bridgeSubAgentEvent(
  event: any,
  ctx: Pick<ToolContext, "streamOutput" | "onAgentEvent" | "onSubAgentInteraction">,
): boolean {
  // A child is never a user-facing principal. Interaction requests cross only
  // the internal owner boundary; the main Agent must review/rephrase them
  // before a server may publish a question or approval.
  if (
    event.type === "approval-request"
    || event.type === "approval-resolved"
    || event.type === "question-request"
    || event.type === "question-resolved"
  ) return true
  if (event.type === "artifact-updated") {
    ctx.onAgentEvent?.(event)
    return true
  }
  return event.type === "tool-stream"
    || event.type === "tool-execution"
    || event.type === "agent-activity"
}

export function childToolState(name: string): AgentActivityState {
  if (
    [
      "read",
      "glob",
      "grep",
      "webfetch",
      "websearch",
      "skill",
      "datasheet_read",
      "schematic_read",
    ].includes(name)
  ) return "reading"
  if (
    [
      "write",
      "edit",
      "project_init",
      "lvgl_gen",
      "write_office",
      "chip_add",
    ].includes(name)
  ) return "editing"
  if (name === "task") return "collaborating"
  if (name === "question" || name === "plan") return "waiting-human"
  return "executing"
}

export function childToolActivity(name: string): string {
  const labels: Record<string, string> = {
    read: "阅读项目文件",
    glob: "查找工程资料",
    grep: "检索代码",
    webfetch: "查阅网页",
    websearch: "联网调研",
    schematic_read: "分析原理图",
    datasheet_read: "阅读数据手册",
    write: "编写文件",
    edit: "修改代码",
    compile: "编译固件",
    flash: "烧录设备",
    swd_debug: "调试硬件",
    task: "召集同事协作",
    plan: "等待方案确认",
    question: "等待用户回复",
  }
  return labels[name] ?? `执行 ${name}`
}

export function rootRunId(
  ctx: Pick<ToolContext, "runId" | "sessionId">,
): string {
  return ctx.runId ?? ctx.sessionId
}

export function failScheduledChild(runId: string, reason: string): void {
  const task = taskScheduler.getTask(runId)
  if (!task) return
  if (task.status === "running") taskScheduler.failTask(runId, reason)
  else if (task.status === "queued" || task.status === "waiting-approval") {
    taskScheduler.cancel(runId)
  }
}

/**
 * Failed delegated writes are rolled back before their scheduler lease is
 * released. If rollback cannot be proven, retain the child in safety-quarantine
 * so another writer cannot silently pass an unresolved change set.
 */
export function rollbackOrRetainForSafety(
  ctx: DelegationContext,
  runId: string,
  agentId: string,
  description: string,
  hasWrites: boolean,
  reason: string,
  collected: string[],
) {
  if (!hasWrites) return undefined
  try {
    workspaceRevisionService.rollback(runId, ctx.sessionId)
    return undefined
  } catch (error) {
    const rollbackError = error instanceof Error ? error.message : String(error)
    const summary = `${reason}；工作区自动回滚未完成：${rollbackError}`
    if (!taskScheduler.quarantineForSafety(runId, summary)) return undefined
    const record = RunContractRepo.get(runId)
    logOrchestrationEvent({
      sessionId: ctx.sessionId,
      runId,
      parentRunId: ctx.runId ?? ctx.sessionId,
      agentId,
      eventType: "delegation.rollback-safety-quarantined",
      level: "error",
      message: "子任务失败且工作区回滚需要主 Agent 处理",
      data: { reason, rollbackError },
    })
    return {
      success: true,
      data: {
        runId,
        status: "safety-quarantine",
        safetyQuarantine: true,
        rollbackRequired: true,
        logicalTaskId: record?.contract.logicalTaskId ?? runId,
        attempt: record?.contract.attempt ?? 1,
        description,
        result: collected.join("").trim().slice(0, 5_000),
        error: summary,
        resultRef: `run-result:${runId}`,
      },
    }
  }
}

export function logDelegationTerminal(
  ctx: DelegationContext,
  runId: string,
  agentId: string,
  eventType: string,
  reason: string,
): void {
  logOrchestrationEvent({
    sessionId: ctx.sessionId,
    runId,
    parentRunId: ctx.runId ?? ctx.sessionId,
    agentId,
    eventType,
    level: eventType === "delegation.failed" ? "error" : "warning",
    message: "子 Agent 委派已结束",
    data: { reason },
  })
}

export function persistTaskResult(
  ctx: Pick<ToolContext, "sessionId">,
  runId: string,
  status: TaskResultStatus,
  summary: string,
  collected: string[],
) {
  const snapshot = ExecutionRunRepo.get(runId)?.snapshot
  const executions = ToolExecutionRepo.listBySession(ctx.sessionId, 100)
    .filter((item) => item.runId === runId)
  const result = {
    status,
    summary: summary.slice(0, 2_000),
    output: collected.join("").trim().slice(0, 200_000),
    artifacts: artifactReferencesFromExecutions(executions),
    evidence: evidenceReferencesFromExecutions(
      executions,
      snapshot?.lastEvidence ?? [],
    ),
    unresolved: (snapshot?.todos ?? [])
      .filter((todo) => todo.status !== "completed")
      .map((todo) => todo.content.slice(0, 1_000))
      .slice(0, 50),
    completedAt: Date.now(),
  }
  const completed = RunContractRepo.complete(runId, result)
  if (!completed) {
    throw new Error(`子任务结果持久化失败：运行契约不存在 ${runId}`)
  }
  logStructuredResultPersisted(
    ctx,
    runId,
    result,
    completed.parentRunId,
    completed.agentId,
  )
  return result
}

export function logStructuredResultPersisted(
  ctx: Pick<ToolContext, "sessionId">,
  runId: string,
  result: ReturnType<typeof buildStructuredTaskResult>,
  parentRunId = RunContractRepo.get(runId)?.parentRunId,
  agentId = RunContractRepo.get(runId)?.agentId ?? "unknown",
): void {
  logOrchestrationEvent({
    sessionId: ctx.sessionId,
    runId,
    parentRunId,
    agentId,
    eventType: "delegation.result-persisted",
    message: "子任务结构化结果已持久化",
    data: {
      status: result.status,
      artifactCount: result.artifacts.length,
      evidenceCount: result.evidence.length,
      unresolvedCount: result.unresolved.length,
      outputChars: result.output.length,
    },
  })
}

export async function resumeParentAfterDelegation(
  parentRunId: string,
  suspended: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!suspended) return
  try {
    await taskScheduler.resumeDelegationAndWait(parentRunId, signal)
  } catch {
    // Parent cancellation is already represented by the scheduler.
  }
}

export class WorkerExitPendingError extends Error {
  constructor() {
    super("取消宽限期结束，但子 Agent Worker 尚未退出")
    this.name = "WorkerExitPendingError"
  }
}

/**
 * Wait normally until cancellation is requested. After cancellation the
 * worker receives a bounded cooperative grace period, but a grace timeout does
 * not mean the worker exited and must never release its scheduler lease.
 */
export async function awaitCooperativeWorkerExit<T>(
  worker: Promise<T>,
  signal: AbortSignal,
  graceMs: number,
): Promise<T> {
  let settled = false
  const observed = worker.then(
    (value) => {
      settled = true
      return value
    },
    (error) => {
      settled = true
      throw error
    },
  )
  if (!signal.aborted) {
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        observed.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => {
          onAbort = resolve
          signal.addEventListener("abort", onAbort, { once: true })
        }),
      ])
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }
  if (settled) return observed
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      observed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WorkerExitPendingError()),
          Math.max(0, graceMs),
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function finalizeDetachedWorkerExit(
  worker: Promise<RunExecutorResult>,
  runId: string,
  ctx: DelegationContext,
  agentId: string,
): void {
  void worker.then(
    () => taskScheduler.confirmWorkerExit(runId, "非协作 Worker 已真实退出"),
    (error) => taskScheduler.confirmWorkerExit(
      runId,
      error instanceof Error ? error.message : String(error),
    ),
  ).then(() => {
    logDelegationTerminal(
      ctx,
      runId,
      agentId,
      "delegation.worker-exited",
      "Worker 已真实退出，资源租约已释放",
    )
  })
}
