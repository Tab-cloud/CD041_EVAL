import type { AgentLoop, AgentLoopInput } from "./agent-loop.ts"
import type { ExecutionSnapshot } from "./agent-loop-control.ts"
import { ExecutionRunRepo } from "../store/execution-run.ts"
import { classifyExecutionTerminal, type ExecutionTerminalDecision } from "./execution-terminal.ts"

export interface RunExecutorResult {
  output: string
  snapshot?: ExecutionSnapshot
  terminal: ExecutionTerminalDecision
}

/**
 * Shared worker execution boundary for delegated and workflow runs.
 * Scheduling remains outside; all workers share snapshot persistence and terminal classification.
 */
export async function executeAgentRun(input: {
  loop: AgentLoop
  run: AgentLoopInput & { runId: string; parentRunId?: string; runType: "subagent" | "workflow-node" }
  onEvent?: (event: any) => void | Promise<void>
}): Promise<RunExecutorResult> {
  let output = ""
  let failure = ""
  let snapshot: ExecutionSnapshot | undefined
  let stop: { reason: string; outstandingTodos: number } | null = null
  for await (const event of input.loop.run({
    ...input.run,
    executionState: {
      ...input.run.executionState,
      persist: (next) => {
        snapshot = next
        ExecutionRunRepo.save(input.run.runId, input.run.sessionId, next, {
          parentRunId: input.run.parentRunId,
          runType: input.run.runType,
        })
        input.run.executionState?.persist?.(next)
      },
    },
  })) {
    if (event.type === "text-delta") output += event.text
    else if (event.type === "error") failure = event.message
    else if ((event as any).type === "execution-stopped") {
      stop = {
        reason: String((event as any).reason ?? "budget-exhausted"),
        outstandingTodos: Number((event as any).outstandingTodos) || 0,
      }
    } else if ((event as any).type === "execution-continued") stop = null
    await input.onEvent?.(event)
  }
  const finalSnapshot = ExecutionRunRepo.get(input.run.runId)?.snapshot ?? snapshot
  const terminal = failure
    ? { status: "failed" as const, reason: failure }
    : classifyExecutionTerminal(finalSnapshot, stop)
  return { output, snapshot: finalSnapshot, terminal }
}
