import type { ChatMessage } from "./types"

export interface ConversationBranchTarget {
  requestId?: string
  seq?: number
}

export function conversationBranchTarget(message: ChatMessage): ConversationBranchTarget | null {
  if (message.role !== "user") return null
  const requestId = message.requestId?.trim()
  const seq = Number.isInteger(message.seq) && (message.seq ?? 0) > 0
    ? message.seq
    : undefined
  if (!requestId && !seq) return null
  return { requestId: requestId || undefined, seq }
}

/**
 * Removes the edited user turn and every message produced after it. The
 * replacement instruction is projected separately from the durable queue.
 */
export function rewindConversationMessages(
  messages: ChatMessage[],
  target: ConversationBranchTarget,
): ChatMessage[] {
  const index = messages.findIndex((message) => {
    if (message.role !== "user") return false
    if (target.requestId) return message.requestId === target.requestId
    return target.seq !== undefined && message.seq === target.seq
  })
  return index < 0 ? messages : messages.slice(0, index)
}
