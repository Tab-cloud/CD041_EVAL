import type { QueuedInstruction } from "./store"
import type { SessionRunProjection } from "./store"
import { isActiveRunStatus } from "./session-run-state"

/** Select the next instruction without allowing a second active SSE run. */
export function nextInstructionForSession(
  queue: QueuedInstruction[],
  sessionId: string | null,
  isStreaming: boolean,
): QueuedInstruction | undefined {
  if (isStreaming) return undefined
  return queue.find((instruction) => instruction.sessionId === sessionId)
}

/**
 * Select the one durable command whose event stream may be attached.
 *
 * The server command queue is the FIFO authority. A local transport ending
 * does not advance this head. If an active run names a request that is not in
 * the latest command projection, the function fails closed rather than
 * subscribing a successor.
 */
export function durableInstructionHead(
  queue: QueuedInstruction[],
  sessionId: string | null,
  run?: SessionRunProjection,
): QueuedInstruction | undefined {
  if (!sessionId) return undefined
  const persisted = queue
    .filter((instruction) =>
      instruction.sessionId === sessionId
      && instruction.serverState !== undefined
      && instruction.serverState !== "local")
    .sort(compareDurablePosition)
  if (run && isActiveRunStatus(run.status)) {
    if (run.requestId) {
      return persisted.find((instruction) => instruction.requestId === run.requestId)
    }
    return persisted.find((instruction) =>
      instruction.serverState === "processing"
      || instruction.serverState === "accepted")
  }
  const started = persisted.find((instruction) =>
    instruction.serverState === "processing"
    || instruction.serverState === "accepted")
  return started ?? persisted[0]
}

/** Any non-terminal local or durable command makes a new user instruction queue behind it. */
export function hasOutstandingSessionInstruction(
  queue: QueuedInstruction[],
  sessionId: string | null,
  run?: SessionRunProjection,
): boolean {
  if (!sessionId) return Boolean(run && isActiveRunStatus(run.status))
  return Boolean(
    run && isActiveRunStatus(run.status)
    || queue.some((instruction) => instruction.sessionId === sessionId),
  )
}

function compareDurablePosition(left: QueuedInstruction, right: QueuedInstruction): number {
  const leftSeq = left.sessionSeq
  const rightSeq = right.sessionSeq
  if (typeof leftSeq === "number" && typeof rightSeq === "number" && leftSeq !== rightSeq) {
    return leftSeq - rightSeq
  }
  if (typeof leftSeq === "number" && typeof rightSeq !== "number") return -1
  if (typeof leftSeq !== "number" && typeof rightSeq === "number") return 1
  return left.createdAt - right.createdAt
}
