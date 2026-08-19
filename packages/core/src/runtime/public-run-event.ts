import { createHash } from "node:crypto"
import type { RuntimeEventType } from "./runtime-protocol.ts"
import type { ToolApprovalRequest } from "./tool-approval.ts"
import type { UserQuestionRequest } from "./user-question.ts"
import { brokerPublicQuestion } from "./main-agent-interaction-broker.ts"
import {
  projectPublicToolExecution,
  type PublicToolExecutionView,
} from "./public-tool-execution.ts"
import { redactInternalImplementationDetails } from "./model-output-policy.ts"

export type PublicProgressPhase = "queued" | "model" | "tools" | "repair" | "finalization"

export interface PublicProblem {
  kind: "problem"
  code:
    | "runtime-failure"
    | "task-blocked"
    | "task-cancelled"
    | "task-interrupted"
    | "model-quota-exhausted"
    | "model-authentication-required"
    | "model-service-unavailable"
    | "model-protocol-incompatible"
  message: string
  diagnosticId: string
  retryable: boolean
}

export interface PublicTaskView {
  kind: "task-status"
  id: string
  status: string
  type: string
  message: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  problem?: PublicProblem
}

export interface PublicHttpTaskView extends PublicTaskView {
  requestId?: string
  sessionId?: string
}

export interface PublicApprovalView {
  kind: "approval"
  id: string
  toolName: string
  reason: string
  target: string
  createdAt: number
  expiresAt: number
}

export interface PublicQuestionView {
  kind: "question"
  id: string
  question: string
  options: string[]
  allowCustom: boolean
  createdAt: number
}

export interface PublicDoneView {
  kind: "done"
  requestId?: string
  taskId?: string
  status: string
  result?: string
  problem?: PublicProblem
  eventLog?: {
    status: "ok" | "degraded"
    replayComplete: boolean
  }
}

export interface PublicRunEvent {
  type: RuntimeEventType
  payload: unknown
}

export interface PublicRunEventRecord {
  eventId: string
  seq: number
  type: RuntimeEventType
  payload: unknown
  createdAt: number
}

export const PUBLIC_RUN_EVENT_PROJECTION_VERSION = 3

/**
 * The only public protocol boundary for live and durable run events.
 *
 * Runtime objects remain rich inside the control plane. This projector creates
 * new allowlisted values for the desktop protocol, so adding a field to an
 * internal record can never expose it accidentally through object spreading.
 */
export function projectPublicRunEvent(
  type: RuntimeEventType,
  payload: unknown,
): PublicRunEvent | null {
  if (type === "heartbeat") {
    return { type, payload: { timestamp: publicTimestamp(objectValue(payload).timestamp) } }
  }
  if (type === "session") {
    const value = objectValue(payload)
    const sessionId = publicId(value.sessionId)
    const taskId = publicId(value.taskId)
    if (!sessionId && !taskId) return null
    return {
      type,
      payload: {
        ...(sessionId ? { sessionId } : {}),
        ...(taskId ? { taskId } : {}),
      },
    }
  }
  if (type === "assistant-part") {
    const value = objectValue(payload)
    const requestId = publicId(value.requestId)
    const partId = publicString(value.partId, 500)
    const partType = value.partType === "reasoning" || value.partType === "text"
      ? value.partType
      : null
    const status = value.status === "start" || value.status === "delta" || value.status === "end"
      ? value.status
      : null
    if (!requestId || !partId || !partType || !status) return null
    const text = status === "delta"
      ? redactInternalImplementationDetails(String(value.text ?? "")).slice(0, 20_000)
      : ""
    if (status === "delta" && !text) return null
    return {
      type,
      payload: {
        requestId,
        partId,
        partType,
        status,
        ...(text ? { text } : {}),
        timestamp: publicTimestamp(value.timestamp),
        ...(status === "end"
          ? { outcome: value.outcome === "discarded" ? "discarded" : "completed" }
          : {}),
      },
    }
  }
  if (type === "agent-progress") {
    const value = objectValue(payload)
    return {
      type,
      payload: {
        phase: publicProgressPhase(value.phase),
        step: positiveInteger(value.step, 1),
        maxSteps: positiveInteger(value.maxSteps, 1),
        ...(positiveInteger(value.toolCount, 0) > 0
          ? { toolCount: positiveInteger(value.toolCount, 1) }
          : {}),
      },
    }
  }
  if (type === "tool-execution") {
    const execution = projectPublicToolExecution(payload)
    return execution ? { type, payload: execution } : null
  }
  if (type === "task-status") {
    const task = projectPublicTaskStatus(payload)
    return task ? { type, payload: task } : null
  }
  if (type === "approval-request") {
    const approval = projectPublicApproval(payload)
    return approval ? { type, payload: approval } : null
  }
  if (type === "question-request") {
    const question = projectPublicQuestion(payload)
    return question ? { type, payload: question } : null
  }
  if (type === "approval-resolved") {
    const value = objectValue(payload)
    const approvalId = publicId(value.approvalId)
    if (!approvalId) return null
    return {
      type,
      payload: {
        approvalId,
        outcome: ["approved", "denied", "expired", "cancelled"].includes(String(value.outcome))
          ? String(value.outcome)
          : "cancelled",
      },
    }
  }
  if (type === "question-resolved") {
    const questionId = publicId(objectValue(payload).questionId)
    return questionId ? { type, payload: { questionId } } : null
  }
  if (type === "error") {
    return { type, payload: projectPublicProblem(payload) }
  }
  if (type === "done") {
    return { type, payload: projectPublicDone(payload) }
  }
  if (type === "graph-event") {
    const value = objectValue(payload)
    const graphId = publicId(value.graphId)
    if (!graphId) return null
    return {
      type,
      payload: {
        graphId,
        version: positiveInteger(value.version, 0),
        type: "graph-updated",
        payload: {},
        createdAt: publicTimestamp(value.createdAt),
      },
    }
  }
  if (type === "serial-context") {
    const value = objectValue(payload)
    return {
      type,
      payload: {
        port: publicString(value.port, 260),
        baudRate: positiveInteger(value.baudRate, 0),
        lineCount: positiveInteger(value.lineCount, 0),
      },
    }
  }
  if (type === "context-compaction") {
    return { type, payload: projectPublicContextCompaction(payload) }
  }
  if (type === "execution-state") {
    return { type, payload: projectPublicExecutionState(payload) }
  }
  if (type === "tool-call") {
    const value = objectValue(payload)
    const name = publicString(value.name, 100)
    if (!name) return null
    const target = publicOperationTarget(value.input)
    return { type, payload: { name, ...(target ? { target } : {}) } }
  }
  if (type === "tool-result") {
    return projectPublicToolResult(payload)
  }
  if (type === "tool-status") {
    const value = objectValue(payload)
    const id = publicId(value.id)
    const name = publicString(value.name, 100)
    if (!id || !name) return null
    const target = publicOperationTarget(value.input)
    return {
      type,
      payload: {
        id,
        name,
        status: publicString(value.status, 64) || "running",
        ...(target ? { target } : {}),
      },
    }
  }
  if (type === "context-capacity") {
    return { type, payload: projectPublicContextCapacity(payload) }
  }
  if (type === "model-routed") {
    return { type, payload: projectPublicModelRoute(payload) }
  }
  if (type === "model-attempt") {
    return { type, payload: projectPublicModelAttempt(payload) }
  }
  if (type === "tool-stream") {
    const value = objectValue(payload)
    const target = ["build", "terminal", "serial"].includes(String(value.target))
      ? String(value.target)
      : "terminal"
    const streamType = ["stdout", "stderr", "info"].includes(String(value.type))
      ? String(value.type)
      : "info"
    return {
      type,
      payload: {
        target,
        name: publicString(value.name, 100),
        text: typeof value.text === "string" ? value.text.slice(0, 200_000) : "",
        type: streamType,
      },
    }
  }
  if (type === "plan-submitted") {
    const value = objectValue(payload)
    const title = publicString(value.title, 500)
    const content = publicString(value.content, 50_000)
    return {
      type,
      payload: {
        ...(title ? { title } : {}),
        ...(content ? { content } : {}),
        ...(Array.isArray(value.options)
          ? {
              options: value.options.slice(0, 8).map((option) => {
                const item = objectValue(option)
                return {
                  label: publicString(item.label, 300),
                  ...(publicString(item.description, 500)
                    ? { description: publicString(item.description, 500) }
                    : {}),
                }
              }).filter((option) => option.label),
            }
          : {}),
      },
    }
  }
  if (type === "agent-activity") {
    const value = objectValue(payload)
    const state = publicAgentActivityState(value.state)
    return {
      type,
      payload: {
        state,
        activity: publicString(value.activity, 500),
        ...(publicString(value.agentName, 100) ? { agentName: publicString(value.agentName, 100) } : {}),
        ...(publicString(value.toolName, 100) ? { toolName: publicString(value.toolName, 100) } : {}),
        timestamp: publicTimestamp(value.timestamp),
      },
    }
  }
  if (type === "execution-stopped") {
    const value = objectValue(payload)
    return {
      type,
      payload: {
        reason: publicString(value.reason, 500) || "任务执行已暂停。",
        outstandingTodos: positiveInteger(value.outstandingTodos, 0),
        ...(value.outstandingSummary && typeof value.outstandingSummary === "object"
          ? { outstandingSummary: publicOutstandingSummary(value.outstandingSummary) }
          : {}),
      },
    }
  }
  if (type === "execution-continued") {
    const value = objectValue(payload)
    return {
      type,
      payload: {
        segment: positiveInteger(value.segment, 0),
        outstandingTodos: positiveInteger(value.outstandingTodos, 0),
      },
    }
  }
  if (type === "execution-blocked") {
    const value = objectValue(payload)
    const reason = value.kind === "problem" ? value : value.reason
    return {
      type,
      payload: projectPublicProblem(reason, "blocked"),
    }
  }
  if (type === "execution-phase") {
    const value = objectValue(payload)
    return {
      type,
      payload: {
        phase: value.phase === "planning" ? "planning" : "execution",
        scope: publicExecutionScope(value.scope),
      },
    }
  }
  if (type === "artifact-updated") {
    return {
      type,
      payload: { revision: positiveInteger(objectValue(payload).revision, 0) },
    }
  }
  return null
}

export function projectPublicRunEventRecord(input: {
  runId?: unknown
  sessionId?: unknown
  seq: number
  type: RuntimeEventType
  payload: unknown
  projectionVersion?: unknown
  createdAt: number
}, context?: { requestId?: string }): PublicRunEventRecord | null {
  if (input.projectionVersion === PUBLIC_RUN_EVENT_PROJECTION_VERSION) {
    return {
      eventId: opaqueId("event", `${String(input.runId ?? "")}:${input.seq}`),
      seq: input.seq,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt,
    }
  }
  const legacyPayload = input.type === "done" && context?.requestId && input.payload && typeof input.payload === "object"
    ? { ...(input.payload as Record<string, unknown>), requestId: context.requestId }
    : input.payload
  const projected = projectPublicRunEvent(input.type, legacyPayload)
  if (!projected) return null
  return {
    eventId: opaqueId("event", `${String(input.runId ?? "")}:${input.seq}`),
    seq: input.seq,
    type: projected.type,
    payload: projected.payload,
    createdAt: input.createdAt,
  }
}

export function projectPublicRunEventRecords(
  events: ReadonlyArray<{
    runId?: unknown
    sessionId?: unknown
    seq: number
    type: RuntimeEventType
    payload: unknown
    projectionVersion?: unknown
    createdAt: number
  }>,
): PublicRunEventRecord[] {
  return events.map((event) => projectPublicRunEventRecord(event)).filter(isPresent)
}

export function projectPublicTaskStatus(payload: unknown): PublicTaskView | null {
  const task = objectValue(payload)
  const id = publicId(task.id)
  if (!id) return null
  const status = publicString(task.status, 64) || "running"
  const rawProblem = task.problem ?? task.error
  return {
    kind: "task-status",
    id,
    status,
    type: publicString(task.type, 64) || "chat",
    message: publicString(task.message, 500),
    createdAt: publicTimestamp(task.createdAt),
    ...(publicTimestamp(task.startedAt) ? { startedAt: publicTimestamp(task.startedAt) } : {}),
    ...(publicTimestamp(task.completedAt) ? { completedAt: publicTimestamp(task.completedAt) } : {}),
    ...(rawProblem ? { problem: projectPublicProblem(rawProblem, status) } : {}),
  }
}

/**
 * HTTP task snapshots use the same sanitized task projector as SSE and add
 * only the durable identifiers required to restore a conversation. Internal
 * agent identity, workspace paths, raw result and raw error never cross this
 * boundary.
 */
export function projectPublicHttpTask(payload: unknown): PublicHttpTaskView | null {
  const value = objectValue(payload)
  const task = projectPublicTaskStatus(payload)
  if (!task) return null
  return {
    ...task,
    ...(publicId(value.requestId) ? { requestId: publicId(value.requestId) } : {}),
    ...(publicId(value.sessionId) ? { sessionId: publicId(value.sessionId) } : {}),
  }
}

export function projectPublicApproval(payload: unknown): PublicApprovalView | null {
  const approval = objectValue(payload)
  const id = publicId(approval.id)
  if (!id) return null
  const toolName = publicString(approval.toolName, 100) || "operation"
  const alreadyPublic = approval.kind === "approval"
  return {
    kind: "approval",
    id,
    toolName,
    reason: alreadyPublic
      ? publicString(approval.reason, 500)
      : `执行 ${toolName} 操作需要你的批准。`,
    target: alreadyPublic
      ? publicString(approval.target, 500) || "当前工作空间"
      : publicApprovalTarget(approval as Partial<ToolApprovalRequest>),
    createdAt: publicTimestamp(approval.createdAt),
    expiresAt: publicTimestamp(approval.expiresAt),
  }
}

export function projectPublicQuestion(payload: unknown): PublicQuestionView | null {
  const question = objectValue(payload)
  const id = publicId(question.id)
  if (!id) return null
  const brokered = typeof question.runId === "string"
    ? brokerPublicQuestion(question as unknown as UserQuestionRequest)
    : question
  return {
    kind: "question",
    id,
    question: publicString(brokered.question, 2_000) || "继续当前任务需要你的选择。",
    options: Array.isArray(brokered.options)
      ? [...new Set(brokered.options
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean))].slice(0, 4)
      : [],
    allowCustom: brokered.allowCustom === true,
    createdAt: publicTimestamp(brokered.createdAt),
  }
}

export function projectPublicProblem(
  payload: unknown,
  status?: string,
): PublicProblem {
  const value = objectValue(payload)
  if (value.kind === "problem"
    && typeof value.code === "string"
    && typeof value.message === "string"
    && typeof value.diagnosticId === "string") {
    return {
      kind: "problem",
      code: publicProblemCode(value.code),
      message: publicProblemMessage(publicProblemCode(value.code)),
      diagnosticId: publicString(value.diagnosticId, 80),
      retryable: value.retryable !== false,
    }
  }
  const source = typeof payload === "string"
    ? payload
    : typeof value.message === "string"
      ? value.message
      : typeof value.error === "string"
        ? value.error
        : JSON.stringify(value)
  const code = publicProblemCodeFromSource(source, status)
  return {
    kind: "problem",
    code,
    message: publicProblemMessage(code),
    diagnosticId: opaqueId("diag", source),
    retryable: code !== "task-cancelled",
  }
}

function projectPublicDone(payload: unknown): PublicDoneView {
  const value = objectValue(payload)
  const status = publicString(value.status, 64) || "failed"
  const rawProblem = value.problem ?? value.error
  return {
    kind: "done",
    ...(publicId(value.requestId) ? { requestId: publicId(value.requestId) } : {}),
    status,
    ...(publicId(value.taskId) ? { taskId: publicId(value.taskId) } : {}),
    ...(typeof value.result === "string" && value.result.trim()
      ? { result: value.result.trim().slice(0, 200_000) }
      : {}),
    ...(rawProblem ? { problem: projectPublicProblem(rawProblem, status) } : {}),
    ...(value.eventLog && typeof value.eventLog === "object"
      ? {
          eventLog: {
            status: objectValue(value.eventLog).status === "degraded" ? "degraded" : "ok",
            replayComplete: objectValue(value.eventLog).replayComplete !== false,
          },
        }
      : {}),
  }
}

function projectPublicContextCompaction(payload: unknown) {
  const value = objectValue(payload)
  const status = ["warning", "start", "complete", "fallback"].includes(String(value.status))
    ? String(value.status)
    : "warning"
  const summary = objectValue(value.summary)
  const summaryContent = publicString(summary.content, 200_000)
  return {
    status,
    used: positiveInteger(value.used, 0),
    total: positiveInteger(value.total, 0),
    ratio: publicRatio(value.ratio),
    threshold: publicRatio(value.threshold),
    message: publicString(value.message, 500) || "上下文容量状态已更新。",
    breakdown: publicNumericBreakdown(value.breakdown),
    protocolMessages: publicUsagePair(value.protocolMessages),
    limitingFactor: value.limitingFactor === "messages" ? "messages" : "tokens",
    ...(summaryContent
      ? {
          summary: {
            content: summaryContent,
            timestamp: publicTimestamp(summary.timestamp),
            ...(positiveInteger(summary.throughSeq, -1) >= 0
              ? { throughSeq: positiveInteger(summary.throughSeq, 0) }
              : {}),
            ...(["manual", "auto", "fallback"].includes(String(summary.mode))
              ? { mode: String(summary.mode) }
              : {}),
            ...(positiveInteger(summary.originalTokens, -1) >= 0
              ? { originalTokens: positiveInteger(summary.originalTokens, 0) }
              : {}),
            ...(positiveInteger(summary.compactedTokens, -1) >= 0
              ? { compactedTokens: positiveInteger(summary.compactedTokens, 0) }
              : {}),
          },
        }
      : {}),
  }
}

function projectPublicExecutionState(payload: unknown) {
  const value = objectValue(payload)
  return {
    state: publicExecutionState(value.state),
    todos: Array.isArray(value.todos)
      ? value.todos.slice(0, 200).map((todo) => {
          const item = objectValue(todo)
          return {
            content: publicString(item.content, 2_000),
            status: publicTodoStatus(item.status),
            priority: publicPriority(item.priority),
          }
        }).filter((todo) => todo.content)
      : [],
    followups: Array.isArray(value.followups)
      ? value.followups.slice(0, 100).map((followup) => {
          const item = objectValue(followup)
          return {
            content: publicString(item.content, 2_000),
            owner: "user",
            category: item.category === "hardware-validation"
              ? "hardware-validation"
              : "external-action",
            ...(publicString(item.reason, 500) ? { reason: publicString(item.reason, 500) } : {}),
          }
        }).filter((followup) => followup.content)
      : [],
    ...(publicString(value.stopReason, 500)
      ? { stopReason: publicString(value.stopReason, 500) }
      : {}),
    updatedAt: publicTimestamp(value.updatedAt),
  }
}

function projectPublicToolResult(payload: unknown): PublicRunEvent | null {
  const value = objectValue(payload)
  const name = publicString(value.name, 100)
  if (!name) return null
  const result = objectValue(value.result)
  const rawProblem = result.error ?? value.error
  const summary = publicString(
    typeof value.result === "string"
      ? value.result
      : result.message ?? result.output ?? result.path,
    2_000,
  )
  return {
    type: "tool-result",
    payload: {
      ...(publicId(value.id) ? { id: publicId(value.id) } : {}),
      name,
      status: rawProblem ? "failed" : "succeeded",
      ...(summary ? { summary } : {}),
      ...(rawProblem ? { problem: projectPublicProblem(rawProblem) } : {}),
    },
  }
}

function projectPublicContextCapacity(payload: unknown) {
  const value = objectValue(payload)
  const usage = objectValue(value.usage)
  return {
    used: positiveInteger(value.used, 0),
    total: positiveInteger(value.total, 0),
    breakdown: publicNumericBreakdown(value.breakdown),
    protocolMessages: publicUsagePair(value.protocolMessages),
    ...(typeof usage.promptTokens === "number" && typeof usage.completionTokens === "number"
      ? {
          usage: {
            promptTokens: positiveInteger(usage.promptTokens, 0),
            completionTokens: positiveInteger(usage.completionTokens, 0),
          },
        }
      : {}),
    source: ["model", "preflight-estimate", "compaction-estimate"].includes(String(value.source))
      ? String(value.source)
      : "model",
    ...(value.estimated === true ? { estimated: true } : {}),
  }
}

function projectPublicModelRoute(payload: unknown) {
  const value = objectValue(payload)
  return {
    modelId: publicString(value.modelId, 600),
    modelName: publicString(value.modelName, 200),
    attempt: positiveInteger(value.attempt, 1),
    fallback: value.fallback === true,
    scope: value.scope === "tool" ? "tool" : "agent",
    segment: positiveInteger(value.segment, 0),
    step: positiveInteger(value.step, 0),
    ...(publicString(value.reason, 300) ? { reason: publicString(value.reason, 300) } : {}),
    ...(value.failureReason
      ? { failureReason: "模型调用未成功，已切换执行路径。" }
      : {}),
  }
}

function projectPublicModelAttempt(payload: unknown) {
  const value = objectValue(payload)
  return {
    attemptId: publicId(value.attemptId),
    scope: value.scope === "agent" ? "agent" : "tool",
    operation: publicString(value.operation, 120),
    segment: positiveInteger(value.segment, 0),
    step: positiveInteger(value.step, 0),
    attempt: positiveInteger(value.attempt, 1),
    maxAttempts: positiveInteger(value.maxAttempts, 0),
    retryDelayMs: positiveInteger(value.retryDelayMs, 0),
    modelId: publicString(value.modelId, 600),
    modelName: publicString(value.modelName, 200),
    status: publicString(value.status, 64) || "failed",
    ...(value.failureReason
      ? { failureReason: "模型调用未成功。" }
      : {}),
  }
}

function publicOperationTarget(payload: unknown): string {
  const input = objectValue(payload)
  for (const key of ["path", "filePath", "projectDir", "outputDir", "query", "description"] as const) {
    const value = publicString(input[key], 500)
    if (value) return value
  }
  if (Array.isArray(input.paths)) {
    return input.paths
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(", ")
  }
  return ""
}

function publicNumericBreakdown(payload: unknown) {
  const value = objectValue(payload)
  return {
    messages: positiveInteger(value.messages, 0),
    systemTools: positiveInteger(value.systemTools, 0),
    skills: positiveInteger(value.skills, 0),
    systemPrompt: positiveInteger(value.systemPrompt, 0),
    other: positiveInteger(value.other, 0),
  }
}

function publicUsagePair(payload: unknown) {
  const value = objectValue(payload)
  return {
    used: positiveInteger(value.used, 0),
    total: positiveInteger(value.total, 0),
  }
}

function publicOutstandingSummary(payload: unknown) {
  const value = objectValue(payload)
  return {
    runnableTodos: positiveInteger(value.runnableTodos, 0),
    verificationGaps: positiveInteger(value.verificationGaps, 0),
    acceptanceGaps: positiveInteger(value.acceptanceGaps, 0),
    total: positiveInteger(value.total, 0),
  }
}

function publicApprovalTarget(approval: Partial<ToolApprovalRequest>): string {
  const input = objectValue(approval.input)
  for (const key of ["path", "projectDir", "outputDir"] as const) {
    const value = publicString(input[key], 500)
    if (value) return value
  }
  if (Array.isArray(input.paths)) {
    const paths = input.paths
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3)
    if (paths.length) return paths.join(", ")
  }
  return "当前工作空间"
}

function publicProblemCode(value: string): PublicProblem["code"] {
  if (value === "task-blocked") return value
  if (value === "task-cancelled") return value
  if (value === "task-interrupted") return value
  if (value === "model-quota-exhausted") return value
  if (value === "model-authentication-required") return value
  if (value === "model-service-unavailable") return value
  if (value === "model-protocol-incompatible") return value
  return "runtime-failure"
}

function publicProblemMessage(code: PublicProblem["code"]): string {
  if (code === "model-quota-exhausted") return "所选模型的配额已耗尽。请切换模型或补充额度后重试。"
  if (code === "model-authentication-required") return "所选模型认证失败。请检查该模型的 API 凭据后重试。"
  if (code === "model-service-unavailable") return "所选模型服务当前不可用。可以稍后重试，或切换到其他模型。"
  if (code === "model-protocol-incompatible") return "所选模型未能完成当前任务所需的调用协议。请切换支持该能力的模型后重试。"
  if (code === "task-blocked") return "任务正在等待外部条件。"
  if (code === "task-cancelled") return "任务已取消。"
  if (code === "task-interrupted") return "任务已暂停，可以继续执行。"
  return "任务执行遇到问题，主 Agent 已保留诊断信息。"
}

function publicProblemCodeFromSource(
  source: string,
  status?: string,
): PublicProblem["code"] {
  if (/(模型配额已耗尽|token\s*plan.{0,40}(?:用量上限|limit)|配额.{0,20}(?:用尽|耗尽|上限)|用量.{0,12}上限)/i.test(source)) {
    return "model-quota-exhausted"
  }
  if (/(模型服务认证失败|invalid api key|unauthorized|http\s*(?:401|403))/i.test(source)) {
    return "model-authentication-required"
  }
  if (/(模型服务请求超时|模型服务暂时不可用|无法连接模型服务|暂时熔断)/i.test(source)) {
    return "model-service-unavailable"
  }
  if (/(模型请求协议不兼容|原生工具调用协议|模型推理模式与工具调用协议不兼容)/i.test(source)) {
    return "model-protocol-incompatible"
  }
  if (status === "blocked") return "task-blocked"
  if (status === "cancelled") return "task-cancelled"
  if (status === "interrupted") return "task-interrupted"
  return "runtime-failure"
}

function publicProgressPhase(value: unknown): PublicProgressPhase {
  if (value === "queued" || value === "tools" || value === "repair" || value === "finalization") {
    return value
  }
  return "model"
}

function publicExecutionState(value: unknown): string {
  if ([
    "running", "waiting-approval", "blocked", "finalizing", "completed",
    "failed", "cancelled", "interrupted",
  ].includes(String(value))) return String(value)
  return "running"
}

function publicTodoStatus(value: unknown): string {
  if (["pending", "in_progress", "paused", "blocked", "completed"].includes(String(value))) {
    return String(value)
  }
  return "pending"
}

function publicPriority(value: unknown): string {
  return ["high", "medium", "low"].includes(String(value)) ? String(value) : "medium"
}

function publicAgentActivityState(value: unknown): string {
  if ([
    "queued", "thinking", "reading", "editing", "executing", "collaborating",
    "waiting-human", "resting", "completed", "failed",
  ].includes(String(value))) return String(value)
  return "executing"
}

function publicExecutionScope(value: unknown): string {
  if (["confirm-changes", "auto-edit", "plan-mode", "full-access"].includes(String(value))) {
    return String(value)
  }
  return "auto-edit"
}

function publicRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0
}

function publicTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.max(0, Math.trunc(value))
    : fallback
}

function publicId(value: unknown): string {
  return publicString(value, 160)
}

function publicString(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : ""
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {}
}

function opaqueId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

export type { PublicToolExecutionView }
