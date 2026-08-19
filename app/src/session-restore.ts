import type { Dispatch } from "react"
import { apiFetch } from "./api"
import { unmaskCommand } from "./chat-commands"
import {
  loadCompactSummary,
  loadContextUsage,
  loadFollowups,
  loadPlan,
  loadTodos,
} from "./store"
import type { AppAction, SessionMeta, TodoItem } from "./store"
import type { ChatMessage } from "./types"
import { executionToWorkLog, type ToolExecutionDto } from "./tool-executions"
import { projectAgentLogEvents, type PublicAgentLogEvent } from "./agent-log-events"
import { projectBuildLogEvents, type PersistedBuildLogEvent } from "./build-log-events"
import { normalizeDeliveredFiles } from "./delivered-files"

export interface SessionRestoreOptions {
  signal?: AbortSignal
  requestTimeoutMs?: number
  retryDelaysMs?: readonly number[]
  fetcher?: typeof apiFetch
}

export interface SessionRestoreResult {
  messagesRestored: boolean
  auxiliaryFailures: number
}

export async function restoreSession(
  session: SessionMeta,
  dispatch: Dispatch<AppAction>,
  isCurrent: () => boolean,
  options: SessionRestoreOptions = {},
): Promise<SessionRestoreResult> {
  const id = session.id
  const contextUsage = loadContextUsage(id)
  dispatch({ type: "SET_CONTEXT_USAGE", usage: contextUsage })
  dispatch({ type: "SET_AGENT", agentId: session.agentId || "auto" })
  dispatch({ type: "SET_TODOS", todos: loadTodos(id) })
  dispatch({ type: "SET_FOLLOWUPS", followups: loadFollowups(id) })

  dispatch({
    type: "SET_ARTIFACTS",
    revision: session.artifactRevision ?? 0,
    schematics: session.schematics ?? [],
    documents: session.documents ?? [],
  })
  dispatch({ type: "SET_COMPACT_SUMMARY", summary: session.compactSummary ?? loadCompactSummary(id) })
  dispatch({ type: "SET_PLAN", plan: loadPlan(id) })
  if (session.projectPath) dispatch({ type: "SET_WORKSPACE", workspace: session.projectPath })

  const request = createRestoreRequest(options)
  const messages = restoreMessages(id, dispatch, isCurrent, request, options.retryDelaysMs ?? [0, 250, 750])
  const auxiliary = restoreAuxiliary(id, dispatch, isCurrent, request)
  const [messagesRestored, auxiliaryFailures] = await Promise.all([messages, auxiliary])
  return { messagesRestored, auxiliaryFailures }
}

type RestoreRequest = <T>(path: string) => Promise<T>

function createRestoreRequest(options: SessionRestoreOptions): RestoreRequest {
  const fetcher = options.fetcher ?? apiFetch
  const timeoutMs = options.requestTimeoutMs ?? 10_000
  return async <T>(path: string): Promise<T> => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(path, { signal: controller.signal })
      if (!response.ok) throw new Error(`会话恢复请求失败: HTTP ${response.status}`)
      return await response.json() as T
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
    }
  }
}

async function restoreMessages(
  sessionId: string,
  dispatch: Dispatch<AppAction>,
  isCurrent: () => boolean,
  request: RestoreRequest,
  retryDelaysMs: readonly number[],
): Promise<boolean> {
  for (const delayMs of retryDelaysMs) {
    if (!isCurrent()) return false
    if (delayMs > 0 && !await waitWhileCurrent(delayMs, isCurrent)) return false
    try {
      const rows = await request<Array<{
        requestId?: string
        attachments?: ChatMessage["attachments"]
        deliveryFiles?: unknown
        parts?: ChatMessage["parts"]
        role: string
        content: string
        agent_id: string
        seq: number
        timestamp: number
      }>>(`/api/messages?sessionId=${encodeURIComponent(sessionId)}`)
      if (!isCurrent() || !Array.isArray(rows)) return false
      dispatch({
        type: "SET_MESSAGES",
        messages: rows.map((row) => {
          const deliveryFiles = normalizeDeliveredFiles(row.deliveryFiles)
          return {
            role: row.role as ChatMessage["role"],
            content: row.role === "user" ? unmaskCommand(row.content) : row.content,
            agentId: row.agent_id ?? "auto",
            seq: row.seq,
            timestamp: row.timestamp,
            ...(row.requestId ? { requestId: row.requestId } : {}),
            ...(row.attachments?.length ? { attachments: row.attachments } : {}),
            ...(deliveryFiles.length ? { deliveryFiles } : {}),
            ...(row.parts?.length ? { parts: row.parts } : {}),
          }
        }),
      })
      return true
    } catch {
      if (!isCurrent()) return false
    }
  }
  return false
}

async function restoreAuxiliary(
  sessionId: string,
  dispatch: Dispatch<AppAction>,
  isCurrent: () => boolean,
  request: RestoreRequest,
): Promise<number> {
  const encoded = encodeURIComponent(sessionId)
  const results = await Promise.allSettled([
    request<{
      approvals?: import("./store").ToolApproval[]
      questions?: import("./store").UserQuestion[]
      tasks?: Array<{
        id: string
        requestId?: string
        sessionId: string
        status: string
        createdAt: number
        startedAt?: number
        completedAt?: number
      }>
      execution?: {
        state?: string
        todos?: TodoItem[]
        followups?: import("./store").FollowupItem[]
      } | null
    }>(`/api/tasks?sessionId=${encoded}&limit=20`),
    request<{
      artifactRevision?: number
      schematics?: import("./store").SchematicData[]
      documents?: import("./store").DocumentItem[]
    }>(`/api/sessions/artifacts?sessionId=${encoded}`),
    request<{ events?: PublicAgentLogEvent[] }>(`/api/tasks/logs?sessionId=${encoded}&limit=500`),
    request<{ events?: PersistedBuildLogEvent[] }>(`/api/build/logs?sessionId=${encoded}&limit=5000`),
  ])
  if (!isCurrent()) return results.filter((result) => result.status === "rejected").length

  const taskPayload = fulfilled(results[0])
  const artifacts = fulfilled(results[1])
  const agentLogPayload = fulfilled(results[2])
  const buildLogPayload = fulfilled(results[3])
  const latestRootRunId = Array.isArray(taskPayload?.tasks) ? taskPayload.tasks[0]?.id : undefined
  const executionResult = latestRootRunId
    ? await Promise.allSettled([
        request<{ executions?: ToolExecutionDto[] }>(
          `/api/tool-executions?sessionId=${encoded}&runId=${encodeURIComponent(latestRootRunId)}&limit=100`,
        ),
      ]).then(([result]) => result)
    : null
  if (!isCurrent()) {
    return results.filter((result) => result.status === "rejected").length
      + Number(executionResult?.status === "rejected")
  }
  const executionPayload = executionResult ? fulfilled(executionResult) : null
  const latestRootStatus = Array.isArray(taskPayload?.tasks) ? taskPayload.tasks[0]?.status : undefined
  dispatch({
    type: "SET_WORK_LOG",
    entries: Array.isArray(executionPayload?.executions)
      ? executionPayload.executions.map(executionToWorkLog).map((entry) => (
          latestRootStatus === "completed" && entry.status === "error"
            ? { ...entry, recovered: true }
            : entry
        ))
      : [],
  })
  if (Array.isArray(taskPayload?.approvals)) {
    dispatch({ type: "SET_PENDING_APPROVALS", approvals: taskPayload.approvals })
  }
  if (Array.isArray(taskPayload?.questions)) {
    dispatch({ type: "SET_PENDING_QUESTIONS", questions: taskPayload.questions })
  }
  if (Array.isArray(taskPayload?.tasks)) {
    const active = taskPayload.tasks.find((task) =>
      ["queued", "running", "waiting-approval", "safety-quarantine"].includes(task.status))
    if (active) {
      dispatch({
        type: "UPSERT_SESSION_RUN",
        run: {
          sessionId,
          requestId: active.requestId ?? "",
          taskId: active.id,
          status: active.status,
          startedAt: active.startedAt ?? active.createdAt,
          updatedAt: active.completedAt ?? Date.now(),
        },
      })
    } else {
      dispatch({ type: "REMOVE_SESSION_RUN", sessionId })
    }
  }
  if (Array.isArray(taskPayload?.execution?.todos)) {
    const terminal = ["blocked", "failed", "cancelled", "interrupted"].includes(String(taskPayload.execution?.state))
    dispatch({
      type: "SET_TODOS",
      todos: terminal
        ? taskPayload.execution.todos.map((todo) => todo.status === "in_progress" ? { ...todo, status: "paused" as const } : todo)
        : taskPayload.execution.todos,
    })
  }
  if (Array.isArray(taskPayload?.execution?.followups)) {
    dispatch({ type: "SET_FOLLOWUPS", followups: taskPayload.execution.followups })
  }
  if (artifacts) {
    dispatch({
      type: "SET_ARTIFACTS",
      revision: Number(artifacts.artifactRevision) || 0,
      schematics: Array.isArray(artifacts.schematics) ? artifacts.schematics : [],
      documents: Array.isArray(artifacts.documents) ? artifacts.documents : [],
    })
  }
  if (Array.isArray(agentLogPayload?.events)) {
    dispatch({ type: "SET_AGENT_LOGS", sessionId, logs: projectAgentLogEvents(agentLogPayload.events) })
  }
  if (Array.isArray(buildLogPayload?.events)) {
    dispatch({ type: "SET_BUILD_LOGS", sessionId, logs: projectBuildLogEvents(buildLogPayload.events) })
  }
  return results.filter((result) => result.status === "rejected").length
    + Number(executionResult?.status === "rejected")
}

function fulfilled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null
}

async function waitWhileCurrent(delayMs: number, isCurrent: () => boolean): Promise<boolean> {
  const intervalMs = Math.min(delayMs, 50)
  let remaining = delayMs
  while (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)))
    if (!isCurrent()) return false
    remaining -= intervalMs
  }
  return true
}
