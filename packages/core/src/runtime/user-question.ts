import { randomUUID } from "node:crypto"
import { logOrchestrationEvent } from "./orchestration-log.ts"

export interface UserQuestionRequest {
  id: string
  sessionId: string
  runId: string
  toolCallId: string
  question: string
  options: string[]
  allowCustom: boolean
  createdAt: number
}

export type UserQuestionOutcome =
  | { status: "answered"; answer: string }
  | { status: "cancelled" }

interface PendingQuestion {
  request: UserQuestionRequest
  resolve: (outcome: UserQuestionOutcome) => void
  removeAbort?: () => void
}

export class UserQuestionManager {
  private readonly pending = new Map<string, PendingQuestion>()

  create(input: {
    sessionId: string
    runId?: string
    toolCallId: string
    question: string
    options?: string[]
    allowCustom?: boolean
    signal?: AbortSignal
  }): { request: UserQuestionRequest; outcome: Promise<UserQuestionOutcome> } {
    const request: UserQuestionRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId ?? input.sessionId,
      toolCallId: input.toolCallId,
      question: input.question.trim().slice(0, 2_000),
      options: [...new Set((input.options ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 4),
      allowCustom: input.allowCustom ?? true,
      createdAt: Date.now(),
    }
    let resolveOutcome: (outcome: UserQuestionOutcome) => void = () => {}
    const outcome = new Promise<UserQuestionOutcome>((resolve) => { resolveOutcome = resolve })
    const pending: PendingQuestion = { request, resolve: resolveOutcome }
    if (input.signal) {
      const abort = () => this.cancel(request.id)
      input.signal.addEventListener("abort", abort, { once: true })
      pending.removeAbort = () => input.signal?.removeEventListener("abort", abort)
    }
    this.pending.set(request.id, pending)
    logOrchestrationEvent({
      sessionId: request.sessionId,
      runId: request.runId,
      eventType: "user-question.requested",
      level: "info",
      message: "主 Agent 正在等待用户选择",
      data: {
        questionId: request.id,
        toolCallId: request.toolCallId,
        optionCount: request.options.length,
        allowCustom: request.allowCustom,
      },
    })
    if (input.signal?.aborted) this.cancel(request.id)
    return { request, outcome }
  }

  respond(id: string, answer: string): UserQuestionRequest | null {
    const pending = this.pending.get(id)
    const normalized = answer.trim().slice(0, 2_000)
    if (!pending || !normalized) return null
    if (!pending.request.allowCustom && !pending.request.options.includes(normalized)) return null
    this.pending.delete(id)
    pending.removeAbort?.()
    logOrchestrationEvent({
      sessionId: pending.request.sessionId,
      runId: pending.request.runId,
      eventType: "user-question.answered",
      level: "info",
      message: "用户已回答，原任务继续执行",
      data: { questionId: id, toolCallId: pending.request.toolCallId },
    })
    pending.resolve({ status: "answered", answer: normalized })
    return pending.request
  }

  validateAnswer(id: string, answer: string):
    | { valid: true; request: UserQuestionRequest }
    | { valid: false; reason: "not-found" | "empty" | "invalid-choice" } {
    const pending = this.pending.get(id)
    if (!pending) return { valid: false, reason: "not-found" }
    const normalized = answer.trim().slice(0, 2_000)
    if (!normalized) return { valid: false, reason: "empty" }
    if (!pending.request.allowCustom && !pending.request.options.includes(normalized)) {
      return { valid: false, reason: "invalid-choice" }
    }
    return { valid: true, request: pending.request }
  }

  list(sessionId?: string): UserQuestionRequest[] {
    return [...this.pending.values()]
      .map((item) => item.request)
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  get(id: string): UserQuestionRequest | null {
    return this.pending.get(id)?.request ?? null
  }

  cancel(id: string): UserQuestionRequest | null {
    const pending = this.pending.get(id)
    if (!pending) return null
    this.pending.delete(id)
    pending.removeAbort?.()
    logOrchestrationEvent({
      sessionId: pending.request.sessionId,
      runId: pending.request.runId,
      eventType: "user-question.cancelled",
      level: "info",
      message: "用户已取消选择，当前操作不会继续执行",
      data: { questionId: id, toolCallId: pending.request.toolCallId },
    })
    pending.resolve({ status: "cancelled" })
    return pending.request
  }
}

export const userQuestionManager = new UserQuestionManager()
