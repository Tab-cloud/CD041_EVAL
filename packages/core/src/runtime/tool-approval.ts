import { randomUUID } from "node:crypto"
import { redactSensitiveRecord } from "./sensitive-data"
import { ToolApprovalRecordRepo } from "../store/tool-approval-record.ts"
import { logOrchestrationEvent } from "./orchestration-log.ts"

export type ApprovalOutcome = "approved" | "denied" | "expired" | "cancelled"
export type ApprovalDecision = "deny" | "allow-once" | "allow-all"

export interface ToolApprovalRequest {
  id: string
  sessionId: string
  runId: string
  parentRunId?: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  reason: string
  target: string
  createdAt: number
  expiresAt: number
}

interface PendingApproval {
  request: ToolApprovalRequest
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

const APPROVAL_TIMEOUT_MS = 5 * 60_000

export class ToolApprovalManager {
  private pending = new Map<string, PendingApproval>()

  constructor(private readonly timeoutMs = APPROVAL_TIMEOUT_MS) {}

  create(input: {
    sessionId: string
    runId?: string
    parentRunId?: string
    toolCallId: string
    toolName: string
    toolInput: Record<string, unknown>
    reason: string
    signal?: AbortSignal
  }): { request: ToolApprovalRequest; outcome: Promise<ApprovalOutcome> } {
    const now = Date.now()
    const request: ToolApprovalRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId ?? input.sessionId,
      parentRunId: input.parentRunId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: redactSensitiveRecord(input.toolInput),
      reason: input.reason,
      target: describeTarget(input.toolInput),
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    }

    let resolveOutcome: (outcome: ApprovalOutcome) => void = () => {}
    const outcome = new Promise<ApprovalOutcome>((resolve) => { resolveOutcome = resolve })
    const timer = setTimeout(() => this.settle(request.id, "expired"), this.timeoutMs)
    const pending: PendingApproval = { request, resolve: resolveOutcome, timer }

    if (input.signal) {
      const abort = () => this.settle(request.id, "cancelled")
      input.signal.addEventListener("abort", abort, { once: true })
      pending.removeAbort = () => input.signal?.removeEventListener("abort", abort)
    }
    try {
      // Durability precedes visibility: an approval must be recoverable before
      // the execution coroutine is allowed to wait on it.
      ToolApprovalRecordRepo.create(request)
    } catch (error) {
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      throw error
    }
    this.pending.set(request.id, pending)
    logOrchestrationEvent({
      sessionId: request.sessionId,
      runId: request.runId,
      parentRunId: request.parentRunId,
      eventType: "permission.requested",
      level: "warning",
      message: "工具调用正在等待用户批准",
      data: {
        approvalId: request.id,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        target: request.target,
        reason: request.reason,
        expiresAt: request.expiresAt,
      },
    })
    if (input.signal?.aborted) this.settle(request.id, "cancelled")
    return { request, outcome }
  }

  respond(id: string, decision: ApprovalDecision | boolean): ToolApprovalRequest | null {
    const request = this.pending.get(id)?.request ?? null
    if (!request) return null
    const normalized = typeof decision === "boolean" ? (decision ? "allow-once" : "deny") : decision
    if (normalized === "allow-all") {
      for (const pending of this.pending.values()) {
        if (pending.request.sessionId === request.sessionId) this.settle(pending.request.id, "approved")
      }
    } else {
      this.settle(id, normalized === "allow-once" ? "approved" : "denied")
    }
    return request
  }

  get(id: string): ToolApprovalRequest | null {
    return this.pending.get(id)?.request ?? null
  }

  list(sessionId?: string): ToolApprovalRequest[] {
    return [...this.pending.values()]
      .map((pending) => pending.request)
      .filter((request) => !sessionId || request.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  approveSession(sessionId: string): ToolApprovalRequest[] {
    const requests = this.list(sessionId)
    for (const request of requests) this.settle(request.id, "approved")
    return requests
  }

  private settle(id: string, outcome: ApprovalOutcome): void {
    const pending = this.pending.get(id)
    if (!pending) return
    // Persist the authoritative decision before waking the coroutine. If this
    // fails, keep the request pending so the user can retry safely.
    ToolApprovalRecordRepo.settle(id, outcome)
    logOrchestrationEvent({
      sessionId: pending.request.sessionId,
      runId: pending.request.runId,
      parentRunId: pending.request.parentRunId,
      eventType: "permission.resolved",
      level: outcome === "approved" ? "info" : "warning",
      message: "工具权限申请已结束",
      data: {
        approvalId: id,
        toolCallId: pending.request.toolCallId,
        toolName: pending.request.toolName,
        outcome,
      },
    })
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    pending.resolve(outcome)
  }
}

function describeTarget(input: Record<string, unknown>): string {
  const value = input.path ?? input.paths ?? input.projectDir ?? input.outputDir ?? input.command
  if (Array.isArray(value)) return value.map(String).slice(0, 3).join(", ")
  return typeof value === "string" ? value.slice(0, 500) : "当前工作空间"
}

export const toolApprovalManager = new ToolApprovalManager()
