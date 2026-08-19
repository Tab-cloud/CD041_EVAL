import { useEffect, useRef, type Dispatch } from "react"
import { apiFetch } from "../api"
import { assertRuntimeProtocol, RuntimeProtocolError } from "../runtime-protocol"
import { restoreSession } from "../session-restore"
import { normalizeCompactSummary } from "../context-state"
import type { AppAction, AppState, CompactSummary, DocumentItem, SchematicData } from "../store"
import type { ModelConfig } from "../types"
import type { SystemSettings } from "../system-settings"
import type { ToolApproval, UserQuestion } from "../store"
import { projectAgentLogEvents, type PublicAgentLogEvent } from "../agent-log-events"
import {
  commandToInstruction,
  commandToRun,
  loadPendingSessionCommands,
} from "../session-commands"
import { notifyTaskCompletion } from "../task-completion-notification"
import { shouldRestoreTerminalTask } from "../terminal-subscription-recovery"

export function useAppLifecycle(
  state: AppState,
  dispatch: Dispatch<AppAction>,
  stopChat: () => void,
  recoverTerminalSubscription: (sessionId: string, taskId: string) => void,
): void {
  const restoreGeneration = useRef(0)
  const observedTerminalTasks = useRef(new Set<string>())
  const taskProjectionInitialized = useRef(false)
  const latestState = useRef(state)
  const terminalRestoreInFlight = useRef(new Set<string>())
  latestState.current = state
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !state.isStreaming) return
      const tag = (event.target as HTMLElement)?.tagName
      if (tag !== "INPUT" && tag !== "TEXTAREA") stopChat()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [state.isStreaming, stopChat])

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", state.theme)
  }, [state.theme])

  useEffect(() => {
    let cancelled = false
    const initialize = async () => {
      while (!cancelled) {
        try {
          const health = await apiFetch("/api/health")
          if (health.ok && !cancelled) {
            assertRuntimeProtocol(await health.json())
            dispatch({ type: "SET_CONNECTION", status: "connected" })
            await loadSystemSettings(dispatch)
            await Promise.all([
              loadAgents(dispatch),
              loadModels(dispatch),
              loadSessions(dispatch),
            ])
            await restorePendingCommands(dispatch, state.instructionQueue).catch((error) => {
              dispatch({
                type: "ADD_WORK_LOG",
                entry: {
                  id: `session-command-restore-${Date.now()}`,
                  type: "error",
                  label: "指令队列恢复失败",
                  detail: error instanceof Error ? error.message : String(error),
                  error: error instanceof Error ? error.message : String(error),
                  timestamp: Date.now(),
                  status: "error",
                },
              })
            })
            return
          }
        } catch (error) {
          dispatch({ type: "SET_CONNECTION", status: "disconnected" })
          if (error instanceof RuntimeProtocolError) {
            dispatch({
              type: "ADD_WORK_LOG",
              entry: {
                id: "runtime-protocol-mismatch",
                type: "error",
                label: "运行时版本不匹配",
                detail: error.message,
                error: error.message,
                timestamp: Date.now(),
                status: "error",
              },
            })
            return
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
    void initialize()
    return () => { cancelled = true }
  }, [dispatch])

  // Agent 日志由后端持久事件流负责。SSE 只用于低延迟显示；此投影负责
  // 初次恢复、断线补偿和运行中的一致性校准。
  useEffect(() => {
    const sessionId = state.activeSessionId
    if (!sessionId) return
    let cancelled = false
    const refreshAgentLogs = async () => {
      try {
        const response = await apiFetch(`/api/tasks/logs?sessionId=${encodeURIComponent(sessionId)}&limit=500`)
        const payload = await response.json().catch(() => ({})) as { events?: PublicAgentLogEvent[] }
        if (!response.ok || cancelled || !Array.isArray(payload.events)) return
        dispatch({ type: "SET_AGENT_LOGS", sessionId, logs: projectAgentLogEvents(payload.events) })
      } catch { /* 保留当前投影，下一次轮询继续补偿 */ }
    }
    void refreshAgentLogs()
    const timer = state.isStreaming ? setInterval(() => void refreshAgentLogs(), 1_000) : undefined
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [dispatch, state.activeSessionId, state.isStreaming])

  useEffect(() => {
    const session = state.sessions.find((value) => value.id === state.activeSessionId)
    if (session?.projectPath) dispatch({ type: "SET_WORKSPACE", workspace: session.projectPath })
  }, [dispatch, state.activeSessionId, state.sessions])

  const restorableSessionId = state.sessions.some((session) => session.id === state.activeSessionId)
    ? state.activeSessionId
    : null
  useEffect(() => {
    if (!restorableSessionId) return
    // A session first discovered through a live command already has an
    // optimistic request-bound timeline. Restoring its partial database
    // history here would replace the assistant placeholder mid-stream.
    if (restorableSessionId === state.liveBoundSessionId) return
    const session = state.sessions.find((value) => value.id === restorableSessionId)
    if (!session) return
    const generation = ++restoreGeneration.current
    const controller = new AbortController()
    void restoreSession(
      session,
      dispatch,
      () => !controller.signal.aborted && restoreGeneration.current === generation,
      { signal: controller.signal },
    )
    return () => controller.abort()
  }, [dispatch, restorableSessionId, state.liveBoundSessionId, state.sessionRestoreNonce])

  // Approval requests are application-level interrupts, not a property of the
  // currently attached SSE stream or the Tasks tab. Poll the authoritative
  // global queue so background workflows and detached runs surface promptly.
  useEffect(() => {
    let cancelled = false
    let lastSignature = ""
    const refreshCommands = async () => {
      try {
        const commands = await loadPendingSessionCommands()
        if (cancelled) return
        dispatch({
          type: "SYNC_SERVER_COMMANDS",
          instructions: commands.map((command) => commandToInstruction(command)),
        })
        for (const command of commands) {
          const run = commandToRun(command)
          if (run) dispatch({ type: "UPSERT_SESSION_RUN", run })
        }
      } catch { /* 命令队列独立重试，不让任务/审批投影阻塞首条指令 */ }
    }
    const refreshApprovals = async () => {
      try {
        const response = await apiFetch("/api/tasks?limit=100")
        const payload = await response.json().catch(() => ({})) as {
          approvals?: ToolApproval[]
          questions?: UserQuestion[]
          tasks?: Array<{
            id: string
            requestId?: string
            sessionId: string
            status: string
            message?: string
            startedAt?: number
            createdAt: number
            completedAt?: number
          }>
        }
        if (!response.ok || cancelled || !Array.isArray(payload.approvals)
          || !Array.isArray(payload.questions) || !Array.isArray(payload.tasks)) return
        for (const task of payload.tasks) {
          const terminal = ["completed", "failed", "cancelled", "interrupted", "blocked"].includes(task.status)
          if (terminal) {
            // SSE is only the low-latency projection. If WebView streaming
            // stalls after the durable terminal commit, detach the matching
            // local reader so useChat immediately restores the authoritative
            // result instead of waiting for its transport watchdog.
            recoverTerminalSubscription(task.sessionId, task.id)
            const current = latestState.current
            const activeRun = current.runsBySession[task.sessionId]
            const shouldRestore = shouldRestoreTerminalTask({
              activeSessionId: current.activeSessionId,
              activeRunTaskId: activeRun?.taskId,
              terminalSessionId: task.sessionId,
              terminalTaskId: task.id,
            })
            const session = shouldRestore
              ? current.sessions.find((item) => item.id === task.sessionId)
              : undefined
            if (session && !terminalRestoreInFlight.current.has(task.id)) {
              terminalRestoreInFlight.current.add(task.id)
              void restoreSession(
                session,
                dispatch,
                () => !cancelled && latestState.current.activeSessionId === task.sessionId,
              ).finally(() => terminalRestoreInFlight.current.delete(task.id))
            }
            dispatch({ type: "REMOVE_SESSION_RUN", sessionId: task.sessionId, taskId: task.id })
            if (taskProjectionInitialized.current && !observedTerminalTasks.current.has(task.id)) {
              void notifyTaskCompletion({
                taskId: task.id,
                status: task.status,
                message: task.message,
              })
            }
            observedTerminalTasks.current.add(task.id)
          } else {
            dispatch({
              type: "UPSERT_SESSION_RUN",
              run: {
                sessionId: task.sessionId,
                requestId: task.requestId ?? "",
                taskId: task.id,
                status: task.status,
                startedAt: task.startedAt ?? task.createdAt,
                updatedAt: task.completedAt ?? Date.now(),
              },
            })
          }
        }
        taskProjectionInitialized.current = true
        const signature = [
          ...payload.approvals.map((item) => `a:${item.id}`),
          ...payload.questions.map((item) => `q:${item.id}`),
        ].join("|")
        if (signature !== lastSignature) {
          lastSignature = signature
          dispatch({ type: "SET_PENDING_APPROVALS", approvals: payload.approvals })
          dispatch({ type: "SET_PENDING_QUESTIONS", questions: payload.questions })
        }
      } catch { /* 后端短暂离线时保留现有审批投影 */ }
    }
    const refreshRuntimeState = () => {
      void refreshCommands()
      void refreshApprovals()
    }
    refreshRuntimeState()
    const timer = setInterval(refreshRuntimeState, 1_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [dispatch, recoverTerminalSubscription])
}

async function loadAgents(dispatch: Dispatch<AppAction>): Promise<void> {
  const response = await apiFetch("/api/agents")
  if (response.ok) dispatch({ type: "SET_AGENTS", agents: await response.json() })
}

async function restorePendingCommands(
  dispatch: Dispatch<AppAction>,
  previous: AppState["instructionQueue"],
): Promise<void> {
  const commands = await loadPendingSessionCommands()
  const prior = new Map(previous.map((instruction) => [instruction.requestId, instruction]))
  dispatch({
    type: "SYNC_SERVER_COMMANDS",
    instructions: commands.map((command) =>
      commandToInstruction(command, prior.get(command.requestId))),
  })
  for (const command of commands) {
    const run = commandToRun(command)
    if (run) dispatch({ type: "UPSERT_SESSION_RUN", run })
  }
}

async function loadModels(dispatch: Dispatch<AppAction>): Promise<void> {
  const response = await apiFetch("/api/models")
  const data = await response.json() as { models?: ModelConfig[] }
  if (!Array.isArray(data.models)) return
  dispatch({ type: "SET_MODEL_CONFIGS", configs: data.models })
}

async function loadSessions(dispatch: Dispatch<AppAction>): Promise<void> {
  const response = await apiFetch("/api/sessions")
  const rows = await response.json() as Array<{
    id: string
    title: string
    agentId: string
    projectPath: string | null
    createdAt: number
    updatedAt: number
    archived: number
    summary: string | null
    compactSummary: CompactSummary | null
    schematics: SchematicData[]
    documents: DocumentItem[]
    artifactRevision: number
    composerPreferences?: import("../store").SessionComposerPreferences
  }>
  if (!Array.isArray(rows)) return
  dispatch({
    type: "SET_SESSIONS",
    sessions: rows.map((row) => ({
      ...row,
      agentId: row.agentId ?? "auto",
      compactSummary: normalizeCompactSummary(row.compactSummary),
      schematics: row.schematics ?? [],
      documents: row.documents ?? [],
      artifactRevision: Number(row.artifactRevision) || 0,
    })),
  })
}

async function loadSystemSettings(dispatch: Dispatch<AppAction>): Promise<SystemSettings | undefined> {
  const response = await apiFetch("/api/settings")
  if (!response.ok) return undefined
  const data = await response.json() as { settings?: SystemSettings }
  if (data.settings) dispatch({ type: "SET_SYSTEM_SETTINGS", settings: data.settings })
  return data.settings
}
