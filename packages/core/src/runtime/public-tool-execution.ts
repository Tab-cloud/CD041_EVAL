import { createHash } from "node:crypto"
import type { ToolExecutionView } from "../store/tool-execution.ts"

export interface PublicToolExecutionView {
  kind: "tool-execution"
  id: string
  toolName: string
  status: ToolExecutionView["status"]
  filePath?: string
  diff?: string
  linesAdded: number
  linesRemoved: number
  reversible: boolean
  problem?: {
    kind: "problem"
    code: "runtime-failure"
    message: string
    diagnosticId: string
    retryable: boolean
  }
  startedAt: number
  finishedAt?: number
  undoneAt?: number
}

/**
 * Root tool activity may be shown as the main Agent's work log. Child activity
 * is private control-plane data; only a concrete workspace mutation is exposed
 * as a project artifact, without child lineage or raw tool arguments.
 */
export function projectPublicToolExecution(execution: unknown): PublicToolExecutionView | null {
  if (!execution || typeof execution !== "object") return null
  const value = execution as Partial<ToolExecutionView> & Partial<PublicToolExecutionView>
  if (!value.id || !value.toolName || !value.status) return null
  if (value.parentRunId && (!value.filePath || !value.diff)) return null
  const rawError = value.problem ?? value.error
  return {
    kind: "tool-execution",
    id: String(value.id),
    toolName: String(value.toolName),
    status: value.status,
    ...(value.filePath ? { filePath: String(value.filePath) } : {}),
    ...(value.diff ? { diff: String(value.diff) } : {}),
    linesAdded: finiteNumber(value.linesAdded),
    linesRemoved: finiteNumber(value.linesRemoved),
    reversible: value.reversible === true,
    ...(rawError ? { problem: publicToolProblem(rawError) } : {}),
    startedAt: finiteNumber(value.startedAt),
    ...(finiteNumber(value.finishedAt) ? { finishedAt: finiteNumber(value.finishedAt) } : {}),
    ...(finiteNumber(value.undoneAt) ? { undoneAt: finiteNumber(value.undoneAt) } : {}),
  }
}

export function projectPublicToolExecutions(executions: ToolExecutionView[]) {
  return executions.map(projectPublicToolExecution).filter(isPresent)
}

function publicToolProblem(value: unknown): PublicToolExecutionView["problem"] {
  if (value && typeof value === "object") {
    const problem = value as Partial<NonNullable<PublicToolExecutionView["problem"]>>
    if (problem.kind === "problem" && problem.diagnosticId) {
      return {
        kind: "problem",
        code: "runtime-failure",
        message: "工具执行遇到问题，主 Agent 已保留诊断信息。",
        diagnosticId: String(problem.diagnosticId).slice(0, 80),
        retryable: problem.retryable !== false,
      }
    }
  }
  return {
    kind: "problem",
    code: "runtime-failure",
    message: "工具执行遇到问题，主 Agent 已保留诊断信息。",
    diagnosticId: `diag-${createHash("sha256").update(
      typeof value === "string" ? value : JSON.stringify(value),
    ).digest("hex").slice(0, 20)}`,
    retryable: true,
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}
