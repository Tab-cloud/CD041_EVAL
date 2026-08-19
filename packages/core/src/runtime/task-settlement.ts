import { ExecutionRunRepo } from "../store/execution-run.ts"
import { RunContractRepo } from "../store/run-contract.ts"
import { ToolExecutionRepo } from "../store/tool-execution.ts"
import {
  artifactReferencesFromExecutions,
  evidenceReferencesFromExecutions,
  type TaskResult,
  type TaskResultStatus,
} from "./run-contract.ts"
import { workspaceRevisionService } from "./workspace-revision.ts"

const settlementLocks = new Map<string, Promise<void>>()

export function buildStructuredTaskResult(input: {
  runId: string
  sessionId: string
  status: TaskResultStatus
  summary: string
  output: string
}): TaskResult {
  const snapshot = ExecutionRunRepo.get(input.runId)?.snapshot
  const executions = ToolExecutionRepo.listBySession(input.sessionId, 200)
    .filter((item) => item.runId === input.runId)
  return {
    status: input.status,
    summary: input.summary.slice(0, 2_000),
    output: input.output.trim().slice(0, 200_000),
    artifacts: artifactReferencesFromExecutions(executions),
    evidence: evidenceReferencesFromExecutions(executions, snapshot?.lastEvidence ?? []),
    unresolved: (snapshot?.todos ?? [])
      .filter((todo) => todo.status !== "completed")
      .map((todo) => todo.content.slice(0, 1_000))
      .slice(0, 50),
    completedAt: Date.now(),
  }
}
/**
 * Completes one child run without inserting a score or acceptance turn.
 *
 * The model receives artifacts, evidence and unresolved work as ordinary
 * result metadata and remains free to continue, retry, reassign or finish.
 * Workspace writes still use an atomic revision commit and never bypass the
 * scheduler's resource boundary.
 */
export async function settleCompletedTask(input: {
  runId: string
  sessionId: string
  result: TaskResult
  resultText: string
  workflowNodeId?: string
}): Promise<boolean> {
  const previous = settlementLocks.get(input.runId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => current)
  settlementLocks.set(input.runId, tail)
  await previous
  try {
    if (RunContractRepo.get(input.runId)?.result) return false
    workspaceRevisionService.prepare(input.runId, input.sessionId, true)
    return RunContractRepo.commitCompletedResult(
      input.runId,
      input.result,
      input.resultText,
      input.workflowNodeId ? { workflowNodeId: input.workflowNodeId } : undefined,
    )
  } finally {
    release()
    if (settlementLocks.get(input.runId) === tail) settlementLocks.delete(input.runId)
  }
}
