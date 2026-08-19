import type { ModelConfig } from "../model-router/types.ts"
import {
  TokenUsageRepo,
  type TokenUsageScope,
} from "../store/token-usage.ts"
import { estimateTokens } from "./context-compaction.ts"
import type { LLMEvent, LLMMessage } from "./llm-client.ts"

export interface ModelUsageContext {
  eventId: string
  attemptId: string
  runId: string
  sessionId: string
  agentId: string
  scope: TokenUsageScope
  operation: string
  segment: number
  step: number
}

export function recordCompletedModelUsage(input: {
  context: ModelUsageContext
  model: ModelConfig
  system: string
  messages: LLMMessage[]
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  events: LLMEvent[]
}): boolean {
  const finish = [...input.events].reverse().find((event) => event.type === "finish")
  if (!finish || finish.type !== "finish") return false
  const actual = finish.usage
  const completionText = input.events
    .filter((event) => event.type === "text-delta" || event.type === "thinking-delta")
    .map((event) => event.type === "text-delta" || event.type === "thinking-delta" ? event.text : "")
    .join("")
  const promptTokens = actual?.promptTokens ?? estimateTokens({
    system: input.system,
    messages: input.messages,
    tools: input.tools ?? [],
  })
  const completionTokens = actual?.completionTokens ?? estimateTokens(completionText)
  return TokenUsageRepo.record({
    id: input.context.eventId,
    attemptId: input.context.attemptId,
    runId: input.context.runId,
    sessionId: input.context.sessionId,
    agentId: input.context.agentId,
    scope: input.context.scope,
    operation: input.context.operation,
    segment: input.context.segment,
    step: input.context.step,
    providerId: input.model.provider,
    modelId: input.model.modelId.split(",")[0]!.trim(),
    modelName: input.model.name,
    promptTokens,
    completionTokens,
    cacheCreationInputTokens: actual?.cacheCreationInputTokens,
    cacheReadInputTokens: actual?.cacheReadInputTokens,
    source: actual ? "actual" : "estimated",
  })
}
