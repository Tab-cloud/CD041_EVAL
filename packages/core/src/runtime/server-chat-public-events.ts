import type { RuntimeEventType } from "./runtime-protocol.ts"
import {
  isInternalOrchestrationTool,
  publicApproval,
  publicQuestion,
} from "./server-chat-projections.ts"
import { ModelOutputPolicy } from "./model-output-policy.ts"

export type PublicRunEventEmitter = (type: RuntimeEventType, payload: unknown) => void

/**
 * Forward root AgentLoop presentation events into the typed public protocol.
 *
 * Stateful orchestration transitions remain in server-chat. Reasoning uses a
 * stateful streaming policy so provider chunks cannot bypass the same public
 * redaction boundary used by assistant deliveries. Child-Agent events never
 * enter this forwarder.
 */
export class PublicAgentEventForwarder {
  private reasoningOutput = new ModelOutputPolicy()
  private reasoningActive = false
  private textActive = false
  private attemptId = ""
  private generation = 0

  constructor(private readonly reasoningEnabled: boolean) {}

  forward(
    event: any,
    input: {
      rootRunId: string
      emit: PublicRunEventEmitter
    },
  ): boolean {
    if (event?.type === "model-attempt") {
      const status = String(event.status ?? "")
      if (event.scope === "agent" && status === "running") this.beginAttempt(event, input)
      if (event.scope === "agent" && status === "reconnecting") this.restartAttempt(input)
      if (event.scope === "agent" && (status === "failed" || status === "cancelled")) {
        this.finishAttempt(input, "discarded")
        this.generation++
      }
      input.emit("model-attempt", {
        attemptId: event.attemptId,
        scope: event.scope === "agent" ? "agent" : "tool",
        operation: event.operation,
        segment: event.segment,
        step: event.step,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        retryDelayMs: event.retryDelayMs,
        modelId: event.modelId,
        modelName: event.modelName,
        status: event.status,
        failureReason: event.failureReason,
      })
      return true
    }
    if (event?.type === "thinking-start") {
      this.ensureReasoning(input, event)
      return true
    }
    if (event?.type === "thinking-delta") {
      this.ensureReasoning(input, event)
      const text = this.reasoningOutput.push(String(event.text ?? ""))
      if (text) this.emitPart(input, "reasoning", "delta", { text })
      return true
    }
    if (event?.type === "thinking-end") {
      const text = this.reasoningOutput.flush()
      if (text) this.emitPart(input, "reasoning", "delta", { text })
      return true
    }
    if (event?.type === "text-delta") {
      if (!this.textActive) {
        this.textActive = true
        this.emitPart(input, "text", "start")
      }
      const text = String(event.text ?? "")
      if (text) this.emitPart(input, "text", "delta", { text })
      return true
    }
    if (event?.type === "finish") {
      this.finishAttempt(input, "completed")
      return false
    }
    if (event?.type === "tool-status") {
      if (!isInternalOrchestrationTool(event.name)) {
        input.emit("tool-status", {
          id: event.id,
          name: event.name,
          status: event.status,
          input: event.input,
        })
      }
      return true
    }
    if (event?.type === "context-capacity") {
      input.emit("context-capacity", {
        used: event.used,
        total: event.total,
        breakdown: event.breakdown,
        usage: event.usage,
        source: event.source,
        estimated: event.estimated,
      })
      return true
    }
    if (event?.type === "tool-stream") {
      input.emit("tool-stream", {
        target: event.target,
        name: event.name,
        text: event.text,
        type: event.streamType,
      })
      return true
    }
    if (event?.type === "question-request") {
      input.emit("question-request", publicQuestion(event.question))
      return true
    }
    if (event?.type === "question-resolved") {
      input.emit("question-resolved", { questionId: event.questionId })
      return true
    }
    if (event?.type === "approval-request") {
      input.emit("approval-request", publicApproval(event.approval))
      return true
    }
    if (event?.type === "approval-resolved") {
      input.emit("approval-resolved", {
        approvalId: event.approvalId,
        outcome: event.outcome,
      })
      return true
    }
    if (event?.type === "tool-execution") {
      if (!isInternalOrchestrationTool(event.execution?.toolName)) {
        input.emit("tool-execution", event.execution)
      }
      return true
    }
    if (event?.type === "agent-activity") {
      if (event.activity?.runId === input.rootRunId) {
        input.emit("agent-activity", event.activity)
      }
      return true
    }
    if (event?.type === "agent-progress") {
      input.emit("agent-progress", {
        phase: event.phase,
        step: event.step,
        maxSteps: event.maxSteps,
        toolCount: event.toolCount,
      })
      return true
    }
    return false
  }

  discard(input: { rootRunId: string; emit: PublicRunEventEmitter }): void {
    this.finishAttempt(input, "discarded")
  }

  discardText(input: { rootRunId: string; emit: PublicRunEventEmitter }): void {
    if (!this.textActive) return
    this.emitPart(input, "text", "end", { outcome: "discarded" })
    this.textActive = false
  }

  private beginAttempt(
    event: any,
    input: { rootRunId: string; emit: PublicRunEventEmitter },
  ): void {
    this.finishAttempt(input, "discarded")
    this.attemptId = String(event.attemptId || `${input.rootRunId}:${event.segment ?? 0}:${event.step ?? 0}`)
    this.generation = 0
    if (this.reasoningEnabled) this.ensureReasoning(input, event)
  }

  private restartAttempt(input: { rootRunId: string; emit: PublicRunEventEmitter }): void {
    this.finishAttempt(input, "discarded")
    this.generation++
    if (this.reasoningEnabled) this.ensureReasoning(input)
  }

  private ensureReasoning(
    input: { rootRunId: string; emit: PublicRunEventEmitter },
    event?: any,
  ): void {
    if (this.reasoningActive) return
    if (!this.attemptId) {
      this.attemptId = `${input.rootRunId}:${event?._step ?? event?.step ?? 0}`
    }
    this.reasoningOutput = new ModelOutputPolicy()
    this.reasoningActive = true
    input.emit("agent-progress", { phase: "model", step: Number(event?._step ?? event?.step) + 1 || 1, maxSteps: 1 })
    this.emitPart(input, "reasoning", "start")
  }

  private finishAttempt(
    input: { rootRunId: string; emit: PublicRunEventEmitter },
    outcome: "completed" | "discarded",
  ): void {
    if (this.reasoningActive) {
      const text = this.reasoningOutput.flush()
      if (text) this.emitPart(input, "reasoning", "delta", { text })
      this.emitPart(input, "reasoning", "end", { outcome })
    }
    if (this.textActive) this.emitPart(input, "text", "end", { outcome })
    this.reasoningActive = false
    this.textActive = false
    this.reasoningOutput = new ModelOutputPolicy()
  }

  private emitPart(
    input: { rootRunId: string; emit: PublicRunEventEmitter },
    partType: "reasoning" | "text",
    status: "start" | "delta" | "end",
    extra: { text?: string; outcome?: "completed" | "discarded" } = {},
  ): void {
    input.emit("assistant-part", {
      partId: `${partType}:${this.attemptId || input.rootRunId}:${this.generation}`,
      partType,
      status,
      timestamp: Date.now(),
      ...extra,
    })
  }
}
