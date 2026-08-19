import { toolApprovalManager } from "./tool-approval"
import { brokerPublicQuestion } from "./main-agent-interaction-broker"
import {
  interactionPayload,
  mainAgentInteractionInbox,
  type SubAgentInteraction,
} from "./main-agent-interaction-inbox"
import { userQuestionManager, type UserQuestionRequest } from "./user-question"

export type ParentInteractionResolution =
  | { status: "answered"; answer: string }
  | { status: "approved" | "denied" | "expired" | "cancelled" }

type InteractionPublisher = (
  type: "question-request" | "question-resolved" | "approval-request" | "approval-resolved",
  payload: unknown,
) => void

/**
 * Move a delegated interaction into the root Agent's durable ownership domain.
 * The child never writes to a public manager and simply awaits this promise.
 */
export async function brokerSubAgentInteraction(input: {
  rootRunId: string
  sessionId: string
  request: SubAgentInteraction
  signal?: AbortSignal
  publish: InteractionPublisher
}): Promise<ParentInteractionResolution> {
  const child = interactionPayload(input.request.payload)
  const stored = mainAgentInteractionInbox.submit({
    rootRunId: input.rootRunId,
    sessionId: input.sessionId,
    request: input.request,
  })
  mainAgentInteractionInbox.escalate(stored.id)

  if (input.request.type === "question-request") {
    const brokered = brokerPublicQuestion(asQuestion(child, input.sessionId, input.rootRunId))
    const pending = userQuestionManager.create({
      sessionId: input.sessionId,
      runId: input.rootRunId,
      toolCallId: stringValue(child.toolCallId) || stored.sourceId,
      question: brokered.question,
      options: brokered.options,
      allowCustom: brokered.allowCustom,
      signal: input.signal,
    })
    input.publish("question-request", pending.request)
    const outcome = await pending.outcome
    mainAgentInteractionInbox.resolve(input.rootRunId, stored.sourceId)
    input.publish("question-resolved", { questionId: pending.request.id })
    return outcome
  }

  const pending = toolApprovalManager.create({
    sessionId: input.sessionId,
    runId: input.rootRunId,
    toolCallId: stringValue(child.toolCallId) || stored.sourceId,
    toolName: stringValue(child.toolName) || "delegated-operation",
    toolInput: objectValue(child.input),
    reason: stringValue(child.reason) || "执行当前任务需要你的批准",
    signal: input.signal,
  })
  input.publish("approval-request", pending.request)
  const outcome = await pending.outcome
  mainAgentInteractionInbox.resolve(input.rootRunId, stored.sourceId)
  input.publish("approval-resolved", { approvalId: pending.request.id, outcome })
  return { status: outcome }
}

function asQuestion(
  payload: Record<string, unknown>,
  sessionId: string,
  rootRunId: string,
): UserQuestionRequest {
  return {
    id: stringValue(payload.id) || rootRunId,
    sessionId,
    runId: stringValue(payload.runId) || rootRunId,
    toolCallId: stringValue(payload.toolCallId) || rootRunId,
    question: stringValue(payload.question) || "继续当前任务需要你的选择",
    options: stringArray(payload.options),
    allowCustom: payload.allowCustom !== false,
    createdAt: numberValue(payload.createdAt) || Date.now(),
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 4)
    : []
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
