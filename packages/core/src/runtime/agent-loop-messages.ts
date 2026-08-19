import type { AgentLoopInput } from "./agent-loop.ts"
import { buildUserContent } from "./agent-prompt.ts"
import { redactInternalImplementationData } from "./model-output-policy.ts"

export interface AgentLoopMessage {
  role: "user" | "assistant" | "tool"
  content: string | any[]
  toolCalls?: any[]
  toolResults?: any[]
  reasoningContent?: string
  reasoningDetails?: Array<Record<string, unknown>>
  originModelId?: string
}

export function buildAgentLoopMessages(
  input: AgentLoopInput,
  supportsVision: boolean,
): {
  messages: AgentLoopMessage[]
  userContent: string | any[]
} {
  const messages: AgentLoopMessage[] = []
  for (const historyEntry of input.history ?? []) {
    if (historyEntry.toolCalls && historyEntry.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: historyEntry.content || "",
        toolCalls: historyEntry.toolCalls,
        reasoningContent: historyEntry.reasoningContent,
        reasoningDetails: historyEntry.reasoningDetails,
        originModelId: historyEntry.originModelId,
      })
      if (historyEntry.toolResults && historyEntry.toolResults.length > 0) {
        messages.push({
          role: "tool",
          content: "",
          toolResults: redactInternalImplementationData(
            historyEntry.toolResults,
          ) as any[],
        })
      }
    } else if (historyEntry.toolResults && historyEntry.toolResults.length > 0) {
      messages.push({
        role: "tool",
        content: "",
        toolResults: redactInternalImplementationData(
          historyEntry.toolResults,
        ) as any[],
      })
    } else {
      messages.push({
        role: historyEntry.role,
        content: historyEntry.content,
      })
    }
  }

  const userContent = buildUserContent(
    input.userMessage,
    input.attachments,
    supportsVision,
  )
  messages.push({ role: "user", content: userContent })
  return { messages, userContent }
}
