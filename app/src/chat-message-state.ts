import type { ChatMessage } from "./types"

/** Preserve the user turn if a replayed assistant event arrives after restore. */
export function updateAssistantMessage(messages: ChatMessage[], content: string): ChatMessage[] {
  const next = [...messages]
  for (let index = next.length - 1; index >= 0; index--) {
    if (next[index].role !== "assistant") continue
    next[index] = { ...next[index], content }
    return next
  }
  return [...next, { role: "assistant", content, agentId: "auto", timestamp: Date.now() }]
}
