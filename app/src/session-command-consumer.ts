import type { QueuedInstruction, SessionRunProjection } from "./store"
import { durableInstructionHead } from "./instruction-queue"

/**
 * Process-local transport leases. Durable command state owns FIFO ordering;
 * this object only prevents two React effects from attaching the same stream
 * concurrently. A detached lease can be reacquired for the same command.
 */
export class SessionCommandConsumerLedger {
  private readonly activeBySession = new Map<string, string>()

  claim(sessionId: string, requestId: string): boolean {
    const session = sessionId.trim()
    const normalized = requestId.trim()
    if (!session || !normalized || this.activeBySession.has(session)) return false
    this.activeBySession.set(session, normalized)
    return true
  }

  release(sessionId: string, requestId: string): boolean {
    const session = sessionId.trim()
    if (this.activeBySession.get(session) !== requestId.trim()) return false
    this.activeBySession.delete(session)
    return true
  }

  activeRequest(sessionId: string): string | undefined {
    return this.activeBySession.get(sessionId.trim())
  }
}

/**
 * Production subscription admission shared by useChat and integration tests.
 * It never advances past a non-terminal server head merely because the local
 * stream or AbortController disappeared.
 */
export function claimDurableSessionInstruction(input: {
  ledger: SessionCommandConsumerLedger
  queue: QueuedInstruction[]
  sessionId: string | null
  run?: SessionRunProjection
  hydrated: boolean
}): QueuedInstruction | undefined {
  if (!input.hydrated || !input.sessionId) return undefined
  const head = durableInstructionHead(input.queue, input.sessionId, input.run)
  if (!head || !input.ledger.claim(input.sessionId, head.requestId)) return undefined
  return head
}

export function startDurableSessionInstructionSubscription(input: {
  ledger: SessionCommandConsumerLedger
  queue: QueuedInstruction[]
  sessionId: string | null
  run?: SessionRunProjection
  hydrated: boolean
  subscribe: (instruction: QueuedInstruction) => Promise<void>
}): QueuedInstruction | undefined {
  const instruction = claimDurableSessionInstruction(input)
  if (!instruction || !input.sessionId) return undefined
  void input.subscribe(instruction).finally(() => {
    input.ledger.release(input.sessionId!, instruction.requestId)
  })
  return instruction
}
