import type { QueuedInstruction } from "./store"

/**
 * The durable command store also carries the command currently owned by the
 * dispatcher. Only commands that have not started belong in the visual
 * "Next" queue:
 *
 * - local: not persisted yet, still waiting
 * - pending: persisted and waiting for the session FIFO head
 * - processing: claimed by the dispatcher, now current work
 * - accepted: bound to a running root task, now current work
 */
export function isWaitingInstruction(instruction: QueuedInstruction): boolean {
  return instruction.serverState === undefined
    || instruction.serverState === "local"
    || instruction.serverState === "pending"
}

export function waitingInstructionsForSession(
  instructions: QueuedInstruction[],
  sessionId: string | null,
  activeRequestId?: string,
): QueuedInstruction[] {
  const sessionInstructions = instructions.filter((instruction) =>
    instruction.sessionId === sessionId)
  const waiting = sessionInstructions.filter((instruction) =>
    instruction.sessionId === sessionId
    && instruction.requestId !== activeRequestId
    && isWaitingInstruction(instruction))

  const hasStartedInstruction = sessionInstructions.some((instruction) =>
    instruction.serverState === "processing"
    || instruction.serverState === "accepted")

  // With no active predecessor, the FIFO head is the current admission being
  // started. It must not be presented as if it were queued behind other work.
  // Only its successors belong under the visual "Next" queue.
  return activeRequestId || hasStartedInstruction ? waiting : waiting.slice(1)
}

/** The local/durable FIFO head currently being admitted, not a successor. */
export function currentAdmissionInstructionForSession(
  instructions: QueuedInstruction[],
  sessionId: string | null,
  activeRequestId?: string,
): QueuedInstruction | undefined {
  if (!sessionId || activeRequestId) return undefined
  const sessionInstructions = instructions.filter((instruction) => instruction.sessionId === sessionId)
  if (sessionInstructions.some((instruction) =>
    instruction.serverState === "processing" || instruction.serverState === "accepted")) {
    return undefined
  }
  return sessionInstructions
    .filter(isWaitingInstruction)
    .sort((left, right) => left.createdAt - right.createdAt)[0]
}
