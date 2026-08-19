import type { QueuedInstruction } from "./store"
import type { ChatMessage } from "./types"

/**
 * Projects locally accepted instructions into the active conversation before
 * the server has created its durable message row. Request identity keeps the
 * projection singular when polling or an SSE reattach later supplies the same
 * user turn.
 */
export function projectInstructionUserMessages(
  messages: ChatMessage[],
  instructions: QueuedInstruction[],
  sessionId: string | null,
): ChatMessage[] {
  if (!sessionId) return messages

  const existingRequests = new Set(messages
    .filter((message) => message.role === "user" && message.requestId)
    .map((message) => message.requestId))
  const optimistic = instructions
    .filter((instruction) =>
      instruction.sessionId === sessionId
      && !instruction.text.trim().startsWith("/compact")
      && !existingRequests.has(instruction.requestId))
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((instruction): ChatMessage => ({
      role: "user",
      requestId: instruction.requestId,
      content: instruction.text,
      agentId: "auto",
      timestamp: instruction.createdAt,
      attachments: instruction.attachments.map(({ name, kind }) => ({ name, kind })),
    }))

  return optimistic.length > 0 ? [...messages, ...optimistic] : messages
}
