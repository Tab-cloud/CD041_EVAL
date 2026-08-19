import type { ExecutionOutstandingSummary, ExecutionSnapshot } from "./agent-loop-control.ts"
import { validateCompletedRunDelivery } from "./agent-delivery-contract.ts"

export interface ExecutionStopSignal {
  reason: string
  outstandingTodos: number
  outstandingSummary?: ExecutionOutstandingSummary
}

export type ExecutionTerminalDecision =
  | { status: "completed"; reason: "" }
  | { status: "blocked" | "interrupted" | "failed"; reason: string }

export interface ExecutionTerminalOptions {
  requirePublicDelivery?: boolean
  publicDelivery?: string
}

/** Translate internal state-machine codes before they reach task errors or SSE. */
function describeOutstanding(summary?: ExecutionOutstandingSummary): string {
  if (!summary) return ""
  const parts = [
    summary.runnableTodos > 0 ? `${summary.runnableTodos} 个待办` : "",
    summary.verificationGaps > 0 ? `${summary.verificationGaps} 个变更验证缺口` : "",
    summary.acceptanceGaps > 0 ? `${summary.acceptanceGaps} 个验收证据缺口` : "",
  ].filter(Boolean)
  return parts.join("、")
}

export function publicExecutionStopReason(
  reason: string | undefined,
  outstandingTodos = 0,
  outstandingSummary?: ExecutionOutstandingSummary,
): string {
  const outstanding = describeOutstanding(outstandingSummary)
  if (reason === "stalled") {
    if (outstanding) return `任务未完成：现有恢复策略未形成新的可验证证据；仍有 ${outstanding}，当前进度已保存`
    return outstandingTodos > 0
      ? `任务未完成：恢复策略已耗尽，仍有 ${outstandingTodos} 项工作未验收`
      : "任务未完成：恢复策略已耗尽，当前进度已保存"
  }
  if (reason === "budget-exhausted") {
    return outstandingTodos > 0
      ? `当前执行段达到安全预算边界，仍有 ${outstandingTodos} 项工作未验收`
      : "当前执行段达到安全预算边界"
  }
  if (reason === "time-limit") {
    return outstandingTodos > 0
      ? `当前执行段达到运行时长边界，仍有 ${outstandingTodos} 项工作未验收`
      : "当前执行段达到运行时长边界"
  }
  return reason || (outstandingTodos > 0 ? `任务尚有 ${outstandingTodos} 项工作未验收` : "任务尚未确认完成")
}

/**
 * Single semantic completion gate shared by chat, delegated runs and workflow
 * nodes. Returning from AgentLoop or producing text is deliberately irrelevant.
 */
export function classifyExecutionTerminal(
  snapshot: ExecutionSnapshot | undefined,
  stop: ExecutionStopSignal | null = null,
  options: ExecutionTerminalOptions = {},
): ExecutionTerminalDecision {
  if (!snapshot) return { status: "interrupted", reason: "执行循环退出，但没有持久化验收状态" }
  if (stop || snapshot.state === "finalizing" || snapshot.state === "interrupted") {
    return {
      status: "interrupted",
      reason: publicExecutionStopReason(
        snapshot.stopReason || stop?.reason,
        stop?.outstandingTodos ?? 0,
        stop?.outstandingSummary,
      ),
    }
  }
  if (snapshot.state === "blocked" || snapshot.state === "waiting-approval") {
    return { status: "blocked", reason: snapshot.stopReason || "等待用户、权限或外部条件" }
  }
  if (snapshot.state === "failed") return { status: "failed", reason: snapshot.stopReason || "任务执行失败" }
  if (snapshot.state === "completed") {
    if (!options.requirePublicDelivery) return { status: "completed", reason: "" }
    const delivery = validateCompletedRunDelivery(options.publicDelivery)
    return delivery.valid
      ? { status: "completed", reason: "" }
      : { status: "failed", reason: delivery.reason }
  }
  return { status: "interrupted", reason: snapshot.stopReason || `执行状态未收敛：${snapshot.state}` }
}
