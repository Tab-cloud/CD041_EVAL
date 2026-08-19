import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject } from "react"
import { apiFetch } from "../api"
import { HELP_TEXT } from "../chat-commands"
import { applyToolResult } from "../chat-tool-results"
import { assertSseStreamCompleted, isSseTransportInterruption, readSse } from "../sse"
import type { AppAction, AppState, LogLine, QueuedInstruction, SessionMeta, ToolApproval } from "../store"
import type { ChatMessage } from "../types"
import type { Attachment } from "../components/chat-helpers"
import { executionToWorkLog, type ToolExecutionDto } from "../tool-executions"
import { restoreSession } from "../session-restore"
import { publishOfficeActivity } from "../office/office-events"
import { toolActivity, toolState } from "../office/office-model"
import type { OfficeActivity, OfficeAgentState } from "../office/types"
import { buildSerialContextPayload } from "../serial-context"
import type { ApprovalDecision } from "../components/ToolApprovalCard"
import { contextUsageAfterCompaction, normalizeCompactSummary } from "../context-state"
import { refreshSessionArtifacts } from "../session-artifacts"
import { notifyTaskCompletion } from "../task-completion-notification"
import { isDeliveredCompletion, resolveTerminalDelivery } from "../terminal-delivery"
import { normalizeDeliveredFiles } from "../delivered-files"
import {
  submitRunGuidance,
  subscribeSessionCommand,
} from "../session-commands"
import { waitingInstructionsForSession } from "../instruction-queue-projection"
import { detachTerminalSubscription } from "../terminal-subscription-recovery"
import { normalizeAgentProgressBounds } from "../agent-progress"
import { useSessionCommandQueue } from "./useSessionCommandQueue"
import { clearSessionConversation } from "../session-clear"

const BACKGROUND_SESSION_EVENTS = new Set([
  "session",
  "heartbeat",
  "task-status",
  "tool-stream",
  "approval-request",
  "approval-resolved",
  "question-request",
  "question-resolved",
  "model-routed",
  "model-attempt",
  "agent-activity",
  "error",
  "done",
])

interface ChatRefs {
  activeSession: MutableRefObject<string | null>
  sessions: MutableRefObject<SessionMeta[]>
  abort: MutableRefObject<AbortController | null>
  requestSequence: MutableRefObject<number>
}

export function useChat(state: AppState, dispatch: Dispatch<AppAction>, refs: ChatRefs) {
  const activeTasksBySession = useRef(new Map<string, string>())
  const abortsBySession = useRef(new Map<string, AbortController>())
  const artifactRevision = useRef(state.artifactRevision)
  useEffect(() => { artifactRevision.current = state.artifactRevision }, [state.artifactRevision])
  const officeAgentId = useRef("general")
  const officeAgentName = useRef("数字员工")
  const addLog = useCallback((target: "terminal" | "serial" | "build", text: string, type: LogLine["type"], sessionId?: string | null, id?: string) => {
    dispatch({ type: "ADD_LOG", target, sessionId: sessionId ?? undefined, line: { id, text, type, timestamp: Date.now() } })
  }, [dispatch])
  const addAgentLog = useCallback((sessionId: string | null, text: string, type: LogLine["type"]) => {
    if (!sessionId) return
    dispatch({ type: "ADD_LOG", target: "log", sessionId, line: { text, type, timestamp: Date.now() } })
  }, [dispatch])

  const stop = useCallback(() => {
    refs.requestSequence.current++
    const sessionId = refs.activeSession.current
    const taskId = sessionId ? activeTasksBySession.current.get(sessionId) : undefined
    if (sessionId) activeTasksBySession.current.delete(sessionId)
    if (taskId) {
      publishMainActivity(taskId, refs.activeSession.current, officeAgentId.current, officeAgentName.current, "resting", "任务已取消，回休息区待命")
      void apiFetch("/api/tasks/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId }),
      }).catch(() => undefined)
    }
    const activeAbort = sessionId ? abortsBySession.current.get(sessionId) : refs.abort.current
    activeAbort?.abort()
    if (sessionId) abortsBySession.current.delete(sessionId)
    refs.abort.current = null
    dispatch({ type: "SET_STREAMING", streaming: false, sessionId, taskId })
    dispatch({ type: "SET_STREAM_START", time: null })
    dispatch({ type: "SET_TOOL_STATUS", tool: null })
    dispatch({ type: "SET_AGENT_PROGRESS", progress: null })
    dispatch({ type: "PAUSE_RUNNING_TODOS" })
    dispatch({ type: "FAIL_RUNNING_WORK_LOGS", error: "请求已取消" })
  }, [dispatch, refs])

  const recoverTerminalSubscription = useCallback((sessionId: string, taskId: string) => {
    detachTerminalSubscription({
      sessionId,
      taskId,
      activeTasksBySession: activeTasksBySession.current,
      abortsBySession: abortsBySession.current,
    })
  }, [])

  const respondToApproval = useCallback(async (approvalId: string, decision: ApprovalDecision) => {
    const approval = state.pendingApprovals.find((item) => item.id === approvalId)
    if (!approval) return
    const response = await apiFetch("/api/approvals/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: approval.id, decision }),
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(detail.error || `审批提交失败: HTTP ${response.status}`)
    }
    dispatch({ type: "REMOVE_PENDING_APPROVAL", approvalId })
  }, [dispatch, state.pendingApprovals])

  const respondToQuestion = useCallback(async (questionId: string, answer: string) => {
    const question = state.pendingQuestions.find((item) => item.id === questionId)
    if (!question) return
    const response = await apiFetch("/api/questions/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: question.id, answer }),
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(detail.error || `回答提交失败: HTTP ${response.status}`)
    }
    dispatch({ type: "REMOVE_PENDING_QUESTION", questionId })
  }, [dispatch, state.pendingQuestions])

  const cancelQuestion = useCallback(async (questionId: string) => {
    const question = state.pendingQuestions.find((item) => item.id === questionId)
    if (!question) return
    const response = await apiFetch("/api/questions/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: question.id }),
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(detail.error || `取消失败: HTTP ${response.status}`)
    }
    dispatch({ type: "REMOVE_PENDING_QUESTION", questionId })
  }, [dispatch, state.pendingQuestions])

  const send = useCallback(async (
    text: string,
    attachments: Attachment[] = [],
    scope = "auto-edit",
    effort = "on",
    agentIdOverride?: string,
    resumeTaskId?: string,
    branchFrom?: QueuedInstruction["branchFrom"],
    queuedInstruction?: QueuedInstruction,
  ) => {
    if (!queuedInstruction && text.trim() === "/clear") {
      const sessionId = state.activeSessionId
      if (!sessionId) return
      try {
        const cleared = await clearSessionConversation(sessionId)
        refs.requestSequence.current++
        const activeAbort = abortsBySession.current.get(sessionId)
        activeAbort?.abort()
        abortsBySession.current.delete(sessionId)
        activeTasksBySession.current.delete(sessionId)
        if (refs.abort.current === activeAbort) refs.abort.current = null
        dispatch({
          type: "CLEAR_SESSION_CONVERSATION",
          sessionId,
          artifactRevision: cleared.artifactRevision,
          clearedAt: Date.now(),
        })
        refs.sessions.current = refs.sessions.current.map((session) => session.id === sessionId
          ? {
              ...session,
              compactSummary: null,
              artifactRevision: cleared.artifactRevision,
              schematics: [],
              documents: [],
            }
          : session)
      } catch (error) {
        addAgentLog(
          sessionId,
          `清除当前会话失败：${error instanceof Error ? error.message : String(error)}`,
          "error",
        )
        return false
      }
      return
    }
    if (!queuedInstruction && text.trim() === "/help") {
      dispatch({ type: "ADD_MESSAGE", message: { role: "assistant", content: HELP_TEXT, agentId: "auto", timestamp: Date.now() } })
      return
    }
    if (!queuedInstruction) {
      const sessionId = state.activeSessionId ?? crypto.randomUUID()
      const queuedForSession = waitingInstructionsForSession(
        state.instructionQueue,
        sessionId,
        state.runsBySession[sessionId]?.requestId,
      )
      if (queuedForSession.length >= 10) {
        addAgentLog(sessionId, "指令队列已达到 10 条，请先移除不需要的指令", "warning")
        return false
      }
      const requestId = crypto.randomUUID()
      const instruction: QueuedInstruction = {
        id: requestId,
        requestId,
        sessionId,
        text,
        attachments,
        scope: normalizeQueuedScope(scope),
        effort: effort === "off" ? "off" : "on",
        modelId: state.activeModelId,
        workingDir: state.workspace,
        agentIdOverride,
        resumeTaskId,
        branchFrom,
        serialContext: state.serialContextEnabled
          ? buildSerialContextPayload(state.serialOutput, state.serialPort, state.serialBaudRate)
          : undefined,
        serverState: "local",
        createdAt: Date.now(),
      }
      if (!state.activeSessionId) {
        refs.activeSession.current = sessionId
        dispatch({ type: "BIND_ACTIVE_SESSION", sessionId })
      }
      dispatch({ type: "ENQUEUE_INSTRUCTION", instruction })
      return
    }
    text = queuedInstruction.text
    attachments = queuedInstruction.attachments
    scope = queuedInstruction.scope
    effort = queuedInstruction.effort
    agentIdOverride = queuedInstruction.agentIdOverride
    resumeTaskId = queuedInstruction.resumeTaskId
    const sequence = ++refs.requestSequence.current
    let sessionId = queuedInstruction.sessionId
    const requestId = queuedInstruction.requestId
    const compact = text.trim().startsWith("/compact")
    beginRequest(dispatch, text, attachments, compact, sessionId, requestId)

    const abort = new AbortController()
    let currentTaskId: string | null = null
    let runKey = sessionId ?? `request:${requestId}`
    abortsBySession.current.set(runKey, abort)
    let backendConnected = false
    let requestTimer: ReturnType<typeof setTimeout> | null = null
    const refreshTransportWatchdog = () => {
      if (requestTimer) clearTimeout(requestTimer)
      requestTimer = setTimeout(() => abort.abort(), 2 * 60_000)
    }
    let lastRunEventId = 0
    refs.abort.current = abort
    try {
      // This watchdog detects a dead transport only. Root execution windows are
      // renewable and therefore must never be reused as a client-side deadline.
      refreshTransportWatchdog()
      if (!sessionId) throw new Error("持久指令缺少会话身份")
      const response = await subscribeSessionCommand(requestId, sessionId, abort.signal)

      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        if (queuedInstruction && (response.status === 404 || response.status === 409)) {
          dispatch({ type: "REMOVE_QUEUED_INSTRUCTION", instructionId: queuedInstruction.id })
        }
        throw new Error(detail.error || `后端返回 HTTP ${response.status}`)
      }
      if (!response.body) throw new Error("后端没有返回事件流")
      backendConnected = true
      dispatch({ type: "SET_CONNECTION", status: "connected" })
      let fullText = ""
      const textParts = new Map<string, string>()
      let streamCompleted = false
      for await (const item of readSse(response.body)) {
        refreshTransportWatchdog()
        if (refs.requestSequence.current !== sequence && refs.activeSession.current === sessionId) return
        if (item.id) lastRunEventId = Math.max(lastRunEventId, item.id)
        const data = item.data
        const attached = !sessionId || refs.activeSession.current === sessionId
        if (!attached && !BACKGROUND_SESSION_EVENTS.has(item.event)) continue
        switch (item.event) {
          case "session":
            if (data.taskId) currentTaskId = String(data.taskId)
            if (data.sessionId) {
              const assignedSessionId = String(data.sessionId)
              if (sessionId && sessionId !== assignedSessionId) {
                throw new Error("持久指令返回了不一致的会话身份")
              }
              if (!sessionId) {
                sessionId = assignedSessionId
                abortsBySession.current.delete(runKey)
                runKey = assignedSessionId
                abortsBySession.current.set(runKey, abort)
                refs.activeSession.current = assignedSessionId
                // 后端首次分配会话 ID 时只绑定 ID，不能走普通“切换会话”动作清空流式消息。
                dispatch({ type: "BIND_ACTIVE_SESSION", sessionId: assignedSessionId })
              }
              if (!refs.sessions.current.some((session) => session.id === assignedSessionId)) {
                await refreshSessions(dispatch, refs.sessions)
              }
            }
            if (sessionId && currentTaskId) {
              activeTasksBySession.current.set(sessionId, currentTaskId)
              dispatch({
                type: "SET_STREAMING",
                streaming: true,
                sessionId,
                requestId,
                taskId: currentTaskId,
              })
            }
            break
          case "heartbeat":
            // 仅用于保持长时间工具规划阶段的 SSE 连接，不产生可见消息。
            break
          case "agent-progress":
            const progressBounds = normalizeAgentProgressBounds(data.step, data.maxSteps)
            dispatch({ type: "SET_AGENT_PROGRESS", progress: {
              phase: data.phase,
              step: progressBounds.step,
              maxSteps: progressBounds.maxSteps,
              ...(data.toolCount ? { toolCount: Number(data.toolCount) } : {}),
            } })
            break
          case "assistant-part": {
            const partType = data.partType === "reasoning" ? "reasoning" : "text"
            const status = data.status === "start" || data.status === "delta" || data.status === "end"
              ? data.status
              : null
            const partId = String(data.partId ?? "")
            if (!status || !partId || !data.requestId) break
            if (partType === "text") {
              if (status === "start" && !textParts.has(partId)) textParts.set(partId, "")
              if (status === "delta") textParts.set(partId, (textParts.get(partId) ?? "") + String(data.text ?? ""))
              if (status === "end" && data.outcome === "discarded") textParts.delete(partId)
              fullText = [...textParts.values()].join("")
            } else if (status === "start") {
              publishMainActivity(currentTaskId, sessionId, officeAgentId.current, officeAgentName.current, "thinking", "站在白板前梳理任务方案")
            }
            if (!compact) dispatch({
              type: "APPLY_ASSISTANT_PART",
              event: {
                requestId: String(data.requestId),
                partId,
                partType,
                status,
                ...(data.text ? { text: String(data.text) } : {}),
                timestamp: Number(data.timestamp) || Date.now(),
                ...(data.outcome === "discarded" ? { outcome: "discarded" as const } : data.outcome === "completed" ? { outcome: "completed" as const } : {}),
                ...(item.id ? { seq: Number(item.id) } : {}),
              },
            })
            break
          }
          case "tool-status":
            handleToolStatus(data, dispatch)
            if (data.status === "running") publishMainActivity(
              currentTaskId, sessionId, officeAgentId.current, officeAgentName.current,
              toolState(String(data.name)), toolActivity(String(data.name)), String(data.name),
            )
            break
          case "tool-call":
            addAgentLog(
              sessionId ?? refs.activeSession.current,
              `${data.name}${data.target ? ` · ${data.target}` : ""}`,
              "tool",
            )
            break
          case "serial-context":
            addAgentLog(
              sessionId ?? refs.activeSession.current,
              `已附加串口上下文：${data.port ?? "unknown"} @ ${data.baudRate ?? "-"}，${data.lineCount ?? 0} 行`,
              "info",
            )
            break
          case "execution-phase":
            dispatch({ type: "SET_PLAN_STATUS", status: "approved" })
            addAgentLog(
              sessionId ?? refs.activeSession.current,
              `规划完成，已切换到${executionScopeLabel(String(data.scope ?? "auto-edit"))}`,
              "success",
            )
            break
          case "tool-stream": {
            const target = data.target === "terminal" ? "terminal" : data.target === "serial" ? "serial" : "build"
            const eventId = item.id && currentTaskId ? `${currentTaskId}:${item.id}` : undefined
            addLog(target, data.text, data.type === "stderr" ? "error" : "info", sessionId ?? refs.activeSession.current, eventId)
            if (attached && state.systemSettings.autoOpenOutput) {
              if (state.bottomPanelCollapsed) dispatch({ type: "SET_BOTTOM_PANEL_COLLAPSED", collapsed: false })
              if (state.bottomPanelTab !== target) dispatch({ type: "SET_BOTTOM_PANEL_TAB", tab: target })
            }
            break
          }
          case "tool-result":
            addAgentLog(
              sessionId ?? refs.activeSession.current,
              `-> ${data.summary || (data.status === "failed" ? data.problem?.message : "已完成")}`,
              data.status === "failed" ? "error" : "result",
            )
            await applyToolResult(data, {
              dispatch,
            })
            break
          case "plan-submitted":
            if (data.title && data.content) {
              dispatch({
                type: "SET_PLAN",
                plan: {
                  title: String(data.title),
                  content: String(data.content),
                  options: Array.isArray(data.options) ? data.options : undefined,
                  status: "showing",
                  timestamp: Date.now(),
                },
              })
            }
            break
          case "artifact-updated":
            if (sessionId && refs.activeSession.current === sessionId
              && Number(data.revision) > artifactRevision.current) {
              const snapshot = await refreshSessionArtifacts(sessionId, dispatch)
              artifactRevision.current = snapshot.artifactRevision
            }
            break
          case "tool-execution": {
            const entry = executionToWorkLog(data as ToolExecutionDto)
            dispatch({ type: "ADD_WORK_LOG", entry })
            break
          }
          case "task-status":
            if (data.id) currentTaskId = String(data.id)
            {
              const eventSessionId = String(sessionId ?? refs.activeSession.current ?? "")
              if (eventSessionId) {
                if (currentTaskId) activeTasksBySession.current.set(eventSessionId, currentTaskId)
                dispatch({
                  type: "UPSERT_SESSION_RUN",
                  run: {
                    sessionId: eventSessionId,
                    requestId,
                    taskId: currentTaskId ?? undefined,
                    status: String(data.status ?? "running"),
                    startedAt: Number(data.startedAt) || Date.now(),
                    updatedAt: Date.now(),
                    lastEventSeq: item.id || undefined,
                  },
                })
              }
            }
            {
              const problemMessage = typeof data.problem?.message === "string"
                ? data.problem.message
                : ""
            if (attached && data.status === "queued") {
              dispatch({ type: "SET_AGENT_PROGRESS", progress: { phase: "queued", step: 0, maxSteps: 1 } })
            } else if (attached && data.status === "running") {
              dispatch({ type: "SET_AGENT_PROGRESS", progress: { phase: "model", step: 1, maxSteps: 1 } })
            }
            officeAgentName.current = state.agents.find((agent) => agent.id === officeAgentId.current)?.name ?? officeAgentId.current
            publishMainActivity(
              data.id ?? currentTaskId, sessionId, officeAgentId.current, officeAgentName.current,
              taskOfficeState(String(data.status)), taskOfficeActivity(String(data.status), problemMessage),
            )
            if (data.status === "completed" && data.id) {
              dispatch({ type: "MARK_WORK_LOG_ERRORS_RECOVERED" })
              void notifyTaskCompletion({
                taskId: String(data.id),
                status: String(data.status),
                message: typeof data.message === "string" ? data.message : undefined,
              })
            }
            if (data.status === "blocked" || data.status === "failed" || data.status === "cancelled" || data.status === "interrupted") {
              dispatch({ type: "FAIL_RUNNING_WORK_LOGS", error: problemMessage || (data.status === "blocked" ? "任务正在等待外部条件" : data.status === "cancelled" ? "任务已取消" : data.status === "interrupted" ? "任务已暂停" : "任务执行失败") })
              dispatch({ type: "PAUSE_RUNNING_TODOS" })
            }
            }
            break
          case "execution-state":
            if (Array.isArray(data.todos)) dispatch({ type: "SET_TODOS", todos: data.todos })
            if (Array.isArray(data.followups)) dispatch({ type: "SET_FOLLOWUPS", followups: data.followups })
            break
          case "context-capacity":
            dispatch({ type: "SET_CONTEXT_USAGE", usage: {
              used: data.used,
              total: data.total,
              breakdown: data.breakdown,
              usage: data.usage,
              protocolMessages: data.protocolMessages,
              updatedAt: Date.now(),
              source: data.source === "preflight-estimate" ? "preflight-estimate" : "model",
              estimated: data.estimated === true,
            } })
            break
          case "context-compaction": {
            const status = String(data.status ?? "")
            if (status === "start") dispatch({ type: "SET_COMPACTING", compacting: true })
            if (status === "complete" || status === "fallback") {
              dispatch({ type: "SET_COMPACTING", compacting: false })
              const summary = normalizeCompactSummary(data.summary)
              if (summary) {
                dispatch({ type: "SET_COMPACT_SUMMARY", summary })
                refs.sessions.current = refs.sessions.current.map((session) => session.id === sessionId
                  ? { ...session, compactSummary: summary, updatedAt: Date.now() }
                  : session)
                dispatch({ type: "SET_SESSIONS", sessions: refs.sessions.current })
              }
            }
            const logType: LogLine["type"] = status === "complete" ? "success"
              : status === "start" ? "info" : "warning"
            addAgentLog(sessionId, String(data.message ?? "上下文容量状态已更新"), logType)
            break
          }
          case "model-routed":
            if (data.modelId) {
              const position = Number.isFinite(Number(data.segment)) && Number.isFinite(Number(data.step))
                ? ` · 执行段 ${Number(data.segment) + 1}/轮 ${Number(data.step) + 1}`
                : ""
              const reason = data.failureReason
                ? ` · 原因：${data.failureReason}`
                : data.fallback && data.reason ? ` · ${data.reason}` : ""
              addAgentLog(
                sessionId ?? refs.activeSession.current,
                `${data.fallback ? "模型回退" : "模型路由"}（对话${position}）：${data.modelName ?? data.modelId}${reason}`,
                data.fallback ? "warning" : "model",
              )
            }
            break
          case "model-attempt": {
            const status = String(data.status ?? "")
            const scope = data.scope === "agent" ? "agent" : "tool"
            if (scope === "agent" && status === "reconnecting") {
              addAgentLog(
                sessionId ?? refs.activeSession.current,
                `模型连接中断，正在重新连接 ${Number(data.attempt) || 1}/${Number(data.maxAttempts) || 1}：${data.modelName ?? data.modelId ?? "当前模型"}`,
                "warning",
              )
              break
            }
            const statusLabel = status === "succeeded" ? "成功"
              : status === "skipped" ? "已跳过"
                : status === "cancelled" ? "已取消"
                  : status === "running" ? "调用中" : "失败"
            const operation = String(data.operation ?? "工具分析")
            const reason = data.failureReason ? ` · 原因：${data.failureReason}` : ""
            const label = scope === "agent" ? "对话模型" : "工具模型"
            addAgentLog(
              sessionId ?? refs.activeSession.current,
              `${label}（${operation} · 第 ${Number(data.attempt) || 1} 次）：${data.modelName ?? data.modelId ?? "未知模型"} · ${statusLabel}${reason}`,
              status === "succeeded" || status === "running" ? "model" : "warning",
            )
            break
          }
          case "approval-request":
            dispatch({ type: "UPSERT_PENDING_APPROVAL", approval: data })
            publishMainActivity(currentTaskId, sessionId, officeAgentId.current, officeAgentName.current, "waiting-human", "举手等待你的批准", String(data.toolName ?? ""))
            break
          case "approval-resolved":
            if (data.approvalId) dispatch({ type: "REMOVE_PENDING_APPROVAL", approvalId: String(data.approvalId) })
            if (data.outcome !== "approved") addAgentLog(sessionId ?? refs.activeSession.current, approvalOutcomeLabel(data.outcome), "warning")
            break
          case "question-request":
            dispatch({ type: "UPSERT_PENDING_QUESTION", question: data })
            publishMainActivity(currentTaskId, sessionId, officeAgentId.current, officeAgentName.current, "waiting-human", "等待你的选择")
            break
          case "question-resolved":
            if (data.questionId) dispatch({ type: "REMOVE_PENDING_QUESTION", questionId: String(data.questionId) })
            break
          case "execution-blocked":
            {
              const blockedMessage = typeof data.message === "string" ? data.message : ""
              if (!blockedMessage) break
              fullText = blockedMessage
              if (attached && !compact) dispatch({ type: "UPDATE_LAST_MESSAGE", content: fullText })
              addAgentLog(sessionId ?? refs.activeSession.current, fullText, "warning")
              publishMainActivity(
                currentTaskId,
                sessionId,
                officeAgentId.current,
                officeAgentName.current,
                "waiting-human",
                fullText,
              )
            }
            break
          case "error":
            if (data.message) {
              fullText = data.message
              if (attached && !compact) dispatch({ type: "UPDATE_LAST_MESSAGE", content: fullText })
              addAgentLog(sessionId ?? refs.activeSession.current, data.message, "error")
              if (attached) dispatch({ type: "FAIL_RUNNING_WORK_LOGS", error: data.message })
              publishMainActivity(currentTaskId, sessionId, officeAgentId.current, officeAgentName.current, "failed", data.message)
            }
            break
          case "agent-activity":
            publishOfficeActivity({
              ...data,
              runId: currentTaskId,
              sessionId,
              agentId: officeAgentId.current,
              agentName: data.agentName || officeAgentName.current,
            } as unknown as OfficeActivity)
            break
          case "done":
            streamCompleted = true
            if (data.status === "completed") {
              dispatch({ type: "MARK_WORK_LOG_ERRORS_RECOVERED" })
            }
            dispatch({
              type: "SETTLE_ASSISTANT_PARTS",
              requestId: String(data.requestId ?? requestId),
              outcome: data.status === "completed" ? "completed" : "discarded",
              timestamp: Date.now(),
            })
            fullText = resolveTerminalDelivery(fullText, data)
            if (attached && !compact) {
              const deliveryFiles = normalizeDeliveredFiles(data.deliveryFiles)
              if (deliveryFiles.length > 0) {
                dispatch({
                  type: "UPSERT_REQUEST_MESSAGE",
                  message: {
                    role: "assistant",
                    requestId,
                    content: fullText,
                    agentId: officeAgentId.current,
                    timestamp: Date.now(),
                    deliveryFiles,
                  },
                })
              } else if (fullText) {
                dispatch({ type: "UPDATE_LAST_MESSAGE", content: fullText })
              }
            }
            if (isDeliveredCompletion(data, fullText)) {
              publishMainActivity(data.taskId ?? currentTaskId, data.sessionId ?? sessionId, officeAgentId.current, officeAgentName.current, "completed", "任务交付完成，准备去喝咖啡")
            }
            break
        }
      }
      assertSseStreamCompleted(streamCompleted)
      if (requestTimer) clearTimeout(requestTimer)
      requestTimer = null

      if (compact) await saveCompactSummary(fullText, sessionId, dispatch, refs.sessions, state.contextUsage)
      if (queuedInstruction) {
        dispatch({ type: "REMOVE_QUEUED_INSTRUCTION", instructionId: queuedInstruction.id })
      }
      if (sessionId) activeTasksBySession.current.delete(sessionId)
      finishRequest(dispatch, sessionId, currentTaskId)
    } catch (error) {
      if (abort.signal.aborted && refs.requestSequence.current !== sequence) return
      const rawMessage = error instanceof Error ? error.message : String(error)
      const transportInterrupted = isSseTransportInterruption(error, abort.signal.aborted)
      let detachedTaskId = currentTaskId
      if (transportInterrupted && backendConnected && !detachedTaskId) {
        try {
          const lookup = await apiFetch(`/api/tasks/status?requestId=${encodeURIComponent(requestId)}`)
          const payload = await lookup.json().catch(() => ({})) as { task?: RecoverableTask }
          if (lookup.ok && payload.task?.id) {
            detachedTaskId = payload.task.id
            currentTaskId = detachedTaskId
            if (!sessionId && payload.task.sessionId) {
              sessionId = payload.task.sessionId
              refs.activeSession.current = sessionId
              dispatch({ type: "BIND_ACTIVE_SESSION", sessionId })
            }
          }
        } catch { /* 服务暂时不可达时走普通传输错误 */ }
      }
      if (transportInterrupted && backendConnected && detachedTaskId && sessionId) {
        if (requestTimer) { clearTimeout(requestTimer); requestTimer = null }
        dispatch({ type: "SET_RECONNECT", attempt: 1 })
        addAgentLog(sessionId ?? refs.activeSession.current, "连接暂时中断，正在恢复后台任务", "warning")
        const recovered = await waitForTask(
          detachedTaskId, sequence, refs.requestSequence,
          5 * 60_000,
          lastRunEventId,
          (task, approvals, execution) => {
            dispatch({ type: "SET_PENDING_APPROVALS", approvals })
            if (Array.isArray(execution?.todos)) dispatch({ type: "SET_TODOS", todos: execution.todos })
            if (Array.isArray(execution?.followups)) dispatch({ type: "SET_FOLLOWUPS", followups: execution.followups })
            if (task.status === "waiting-approval") {
              publishMainActivity(detachedTaskId, sessionId, officeAgentId.current, officeAgentName.current, "waiting-human", task.problem?.message || "等待你的确认")
            }
          },
          (events) => replayRunEvents(events, sessionId!, dispatch, (message) => addAgentLog(sessionId, message, "error")),
          (attempt) => dispatch(attempt > 0
            ? { type: "SET_RECONNECT", attempt }
            : { type: "SET_CONNECTION", status: "connected" }),
        )
        if (refs.requestSequence.current !== sequence) return
        if (sessionId) activeTasksBySession.current.delete(sessionId)
        if (recovered && !["queued", "running", "waiting-approval"].includes(recovered.status)) {
          dispatch({ type: "SET_CONNECTION", status: "connected" })
          await refreshSessions(dispatch, refs.sessions)
          const recoveredSession = refs.sessions.current.find((item) => item.id === sessionId)
          if (recoveredSession) {
            await restoreSession(recoveredSession, dispatch, () => refs.requestSequence.current === sequence)
          }
          const label = recovered.status === "completed" ? "后台任务已完成，结果已恢复"
            : recovered.status === "blocked" ? recovered.problem?.message || "后台任务正在等待外部条件"
              : recovered.problem?.message || `后台任务已${recovered.status === "cancelled" ? "取消" : "停止"}`
          addAgentLog(sessionId ?? refs.activeSession.current, label, recovered.status === "completed" ? "success" : "warning")
          if (queuedInstruction) {
            dispatch({ type: "REMOVE_QUEUED_INSTRUCTION", instructionId: queuedInstruction.id })
          }
          finishRequest(dispatch, sessionId, detachedTaskId)
          return
        }
        const recoveredError = recovered?.problem?.message
          || (recovered?.status === "cancelled" ? "任务已取消" : "后台任务恢复失败")
        dispatch({ type: "FAIL_RUNNING_WORK_LOGS", error: recoveredError })
        dispatch({ type: "UPDATE_LAST_MESSAGE", content: recoveredError })
        addAgentLog(sessionId ?? refs.activeSession.current, recoveredError, "error")
        finishRequest(dispatch, sessionId, detachedTaskId)
        return
      }
      finishRequest(dispatch, sessionId, currentTaskId)
      const message = transportInterrupted
        ? "无法连接本地 Agent 服务，请确认后台服务已启动。"
        : rawMessage
      dispatch({ type: "FAIL_RUNNING_WORK_LOGS", error: message })
      dispatch({ type: "UPDATE_LAST_MESSAGE", content: message })
      dispatch({ type: "SET_CONNECTION", status: backendConnected ? "connected" : "disconnected" })
      addAgentLog(sessionId ?? refs.activeSession.current, message, "error")
    } finally {
      if (requestTimer) clearTimeout(requestTimer)
      abortsBySession.current.delete(runKey)
      if (refs.abort.current === abort) refs.abort.current = null
    }
  }, [addAgentLog, addLog, dispatch, refs, state.activeModelId, state.activeSessionId, state.bottomPanelCollapsed, state.bottomPanelTab, state.contextUsage, state.instructionQueue, state.isStreaming, state.runsBySession, state.serialBaudRate, state.serialContextEnabled, state.serialOutput, state.serialPort, state.systemSettings.autoOpenOutput, state.systemSettings.executionBudget.rootWindowMs, state.workspace])

  const guide = useCallback(async (
    text: string,
    attachments: Attachment[] = [],
  ): Promise<false | void> => {
    const sessionId = state.activeSessionId
    const activeRun = sessionId ? state.runsBySession[sessionId] : undefined
    const taskId = sessionId
      ? activeTasksBySession.current.get(sessionId) ?? activeRun?.taskId
      : undefined
    if (!state.isStreaming || !sessionId || !taskId) {
      addAgentLog(sessionId, "当前任务尚未建立，补充要求未发送；可稍后重试或选择排队", "warning")
      return false
    }
    const requestId = crypto.randomUUID()
    try {
      const guidance = await submitRunGuidance({
        requestId,
        taskId,
        sessionId,
        text,
        attachments,
        workingDir: state.workspace,
      })
      if (refs.activeSession.current === sessionId) {
        dispatch({
          type: "ADD_GUIDANCE_MESSAGE",
          activeRequestId: activeRun?.requestId,
          message: {
            role: "user",
            requestId: guidance.requestId,
            content: guidance.message,
            agentId: "auto",
            timestamp: guidance.createdAt,
            attachments: guidance.attachments,
          },
        })
      }
      addAgentLog(sessionId, "补充要求已进入当前任务，将在下一个模型或工具边界生效", "success")
    } catch (error) {
      addAgentLog(
        sessionId,
        `引导当前任务失败：${error instanceof Error ? error.message : String(error)}`,
        "warning",
      )
      return false
    }
  }, [addAgentLog, dispatch, refs, state.activeSessionId, state.isStreaming, state.runsBySession, state.workspace])

  const subscribeQueuedInstruction = useCallback(
    async (instruction: QueuedInstruction) => { await send(
        instruction.text,
        instruction.attachments,
        instruction.scope,
        instruction.effort,
        instruction.agentIdOverride,
        instruction.resumeTaskId,
        instruction.branchFrom,
        instruction,
      ) },
    [send],
  )
  useSessionCommandQueue({
    state,
    dispatch,
    addAgentLog,
    subscribe: subscribeQueuedInstruction,
  })

  return { send, guide, stop, recoverTerminalSubscription, respondToApproval, respondToQuestion, cancelQuestion }
}

function normalizeQueuedScope(value: string): QueuedInstruction["scope"] {
  return ["confirm-changes", "auto-edit", "plan-mode", "full-access"].includes(value)
    ? value as QueuedInstruction["scope"]
    : "auto-edit"
}

function publishMainActivity(
  runId: string | null,
  sessionId: string | null,
  agentId: string,
  agentName: string,
  officeState: OfficeAgentState,
  activity: string,
  toolName?: string,
): void {
  if (!runId || !sessionId) return
  publishOfficeActivity({ runId, sessionId, agentId, agentName, state: officeState, activity, toolName: toolName || undefined, timestamp: Date.now() })
}

function taskOfficeState(status: string): OfficeAgentState {
  if (status === "queued") return "queued"
  if (status === "completed") return "completed"
  if (["waiting-approval", "safety-quarantine", "blocked"].includes(status)) return "waiting-human"
  if (["failed", "interrupted"].includes(status)) return "failed"
  if (status === "cancelled") return "resting"
  return "executing"
}

function taskOfficeActivity(status: string, error?: string): string {
  if (status === "queued") return "在大厅排队等待工位"
  if (status === "running") return "已经打卡，坐到专属工位开始处理任务"
  if (status === "waiting-delegation") return "主 Agent 正在等待子任务返回并准备统一验收"
  if (status === "safety-quarantine") return error || "工作区清理未完成，已进入安全隔离"
  if (status === "waiting-approval") return error || "等待你的确认"
  if (status === "blocked") return error || "等待用户、权限、硬件或其他外部条件"
  if (status === "completed") return "完成交付，准备去休息区"
  if (status === "cancelled") return "任务取消，回到待命区"
  if (status === "failed" || status === "interrupted") return error || "任务遇到故障"
  return `任务状态：${status}`
}

interface RecoverableTask {
  id?: string
  sessionId?: string
  status: "queued" | "running" | "waiting-approval" | "waiting-delegation" | "safety-quarantine" | "blocked" | "completed" | "failed" | "cancelled" | "interrupted"
  problem?: { message?: string }
}

interface RecoverableExecution {
  state: string
  todos?: AppState["todos"]
  followups?: AppState["followups"]
  stopReason?: string
}

interface RecoverableRunEvent {
  eventId: string
  seq: number
  type: string
  payload: any
  createdAt: number
}

async function waitForTask(
  taskId: string,
  sequence: number,
  requestSequence: MutableRefObject<number>,
  recoveryInactivityMs: number,
  afterEventId = 0,
  onSnapshot?: (task: RecoverableTask, approvals: ToolApproval[], execution: RecoverableExecution | null) => void,
  onEvents?: (events: RecoverableRunEvent[]) => void,
  onReconnectState?: (attempt: number) => void,
): Promise<RecoverableTask | null> {
  let lastSuccessfulContact = Date.now()
  let eventCursor = afterEventId
  let consecutiveFailures = 1
  while (Date.now() - lastSuccessfulContact < recoveryInactivityMs && requestSequence.current === sequence) {
    let contacted = false
    try {
      const eventResponse = await apiFetch(`/api/tasks/events?id=${encodeURIComponent(taskId)}&after=${eventCursor}`)
      const eventPayload = await eventResponse.json().catch(() => ({})) as { events?: RecoverableRunEvent[] }
      if (eventResponse.ok) {
        lastSuccessfulContact = Date.now()
        contacted = true
      }
      if (eventResponse.ok && Array.isArray(eventPayload.events) && eventPayload.events.length > 0) {
        onEvents?.(eventPayload.events)
        eventCursor = Math.max(eventCursor, ...eventPayload.events.map((event) => event.seq))
      }
      const response = await apiFetch(`/api/tasks/status?id=${encodeURIComponent(taskId)}`)
      const payload = await response.json().catch(() => ({})) as { task?: RecoverableTask; approvals?: ToolApproval[]; execution?: RecoverableExecution | null }
      if (response.ok && payload.task) {
        lastSuccessfulContact = Date.now()
        contacted = true
        onSnapshot?.(payload.task, Array.isArray(payload.approvals) ? payload.approvals : [], payload.execution ?? null)
        if (!["queued", "running", "waiting-approval", "waiting-delegation", "safety-quarantine"].includes(payload.task.status)) {
          return payload.task
        }
      }
    } catch { /* 本地服务短暂不可用时继续恢复 */ }
    if (contacted) {
      if (consecutiveFailures > 0) onReconnectState?.(0)
      consecutiveFailures = 0
    } else {
      consecutiveFailures += 1
      onReconnectState?.(consecutiveFailures)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return null
}

function replayRunEvents(
  events: RecoverableRunEvent[],
  sessionId: string,
  dispatch: Dispatch<AppAction>,
  onError: (message: string) => void,
): void {
  for (const event of events) {
    const data = event.payload ?? {}
    if (event.type === "approval-request") dispatch({ type: "UPSERT_PENDING_APPROVAL", approval: data })
    else if (event.type === "approval-resolved" && data.approvalId) {
      dispatch({ type: "REMOVE_PENDING_APPROVAL", approvalId: String(data.approvalId) })
    } else if (event.type === "question-request") {
      dispatch({ type: "UPSERT_PENDING_QUESTION", question: data })
    } else if (event.type === "question-resolved" && data.questionId) {
      dispatch({ type: "REMOVE_PENDING_QUESTION", questionId: String(data.questionId) })
    } else if (event.type === "execution-state" && Array.isArray(data.todos)) {
      dispatch({ type: "SET_TODOS", todos: data.todos })
      if (Array.isArray(data.followups)) dispatch({ type: "SET_FOLLOWUPS", followups: data.followups })
    } else if (event.type === "tool-execution") {
      dispatch({ type: "ADD_WORK_LOG", entry: executionToWorkLog(data as ToolExecutionDto) })
    } else if (event.type === "context-compaction") {
      const status = String(data.status ?? "")
      if (status === "start") dispatch({ type: "SET_COMPACTING", compacting: true })
      if (status === "complete" || status === "fallback") {
        dispatch({ type: "SET_COMPACTING", compacting: false })
        const summary = normalizeCompactSummary(data.summary)
        if (summary) dispatch({ type: "SET_COMPACT_SUMMARY", summary })
      }
    } else if (event.type === "tool-stream" && data.target === "build" && typeof data.text === "string") {
      dispatch({
        type: "ADD_LOG",
        target: "build",
        sessionId,
        line: {
          id: event.eventId || `event:${event.seq}`,
          text: data.text,
          type: data.type === "stderr" ? "error" : "info",
          timestamp: Number(event.createdAt) || Date.now(),
        },
      })
    } else if (event.type === "error" && data.message) {
      onError(String(data.message))
    }
  }
}

function beginRequest(
  dispatch: Dispatch<AppAction>,
  text: string,
  attachments: Attachment[],
  compact: boolean,
  sessionId: string | null,
  requestId: string,
): void {
  dispatch({ type: "SET_STREAMING", streaming: true, sessionId, requestId })
  dispatch({ type: "SET_STREAM_START", time: Date.now() })
  dispatch({ type: "SET_CONNECTION", status: "connecting" })
  dispatch({ type: "SET_TOOL_STATUS", tool: null })
  dispatch({ type: "SET_AGENT_PROGRESS", progress: null })
  // The activity card describes one root run. Session history is restored
  // separately and must never be counted as work performed by this request.
  dispatch({ type: "CLEAR_WORK_LOG" })
  // 后台任务可能已有其他审批，开始新请求不能清空全局审批队列。
  dispatch({ type: "SET_COMPACTING", compacting: compact })
  if (!compact) {
    const message: ChatMessage & { requestId: string } = {
      role: "user",
      requestId,
      content: text,
      agentId: "auto",
      timestamp: Date.now(),
      attachments: attachments.map(({ name, kind }) => ({ name, kind })),
    }
    dispatch({ type: "UPSERT_REQUEST_MESSAGE", message })
    dispatch({
      type: "UPSERT_REQUEST_MESSAGE",
      message: {
        role: "assistant",
        requestId,
        content: "",
        agentId: "auto",
        timestamp: Date.now(),
      },
    })
  }
}

function finishRequest(
  dispatch: Dispatch<AppAction>,
  sessionId: string | null,
  taskId: string | null,
): void {
  dispatch({ type: "SET_STREAMING", streaming: false, sessionId, taskId: taskId ?? undefined })
  dispatch({ type: "SET_STREAM_START", time: null })
  dispatch({ type: "SET_COMPACTING", compacting: false })
  dispatch({ type: "SET_TOOL_STATUS", tool: null })
  dispatch({ type: "SET_AGENT_PROGRESS", progress: null })
  dispatch({ type: "PAUSE_RUNNING_TODOS" })
}

function approvalOutcomeLabel(outcome: string): string {
  if (outcome === "denied") return "工具操作已被用户拒绝"
  if (outcome === "expired") return "工具操作审批已超时"
  return "工具操作审批已取消"
}

function executionScopeLabel(scope: string): string {
  if (scope === "full-access") return "完整访问模式"
  if (scope === "confirm-changes") return "变更前确认模式"
  return "自动编辑模式"
}

function handleToolStatus(data: any, dispatch: Dispatch<AppAction>): void {
  dispatch({ type: "SET_TOOL_STATUS", tool: data.status === "running" ? { name: data.name, input: data.input } : null })
}

async function saveCompactSummary(
  content: string,
  sessionId: string | null,
  dispatch: Dispatch<AppAction>,
  sessionsRef: MutableRefObject<SessionMeta[]>,
  currentUsage: AppState["contextUsage"],
): Promise<void> {
  if (!content.trim()) throw new Error("压缩摘要为空，未修改当前上下文")
  if (!sessionId) throw new Error("当前会话尚未建立，无法保存压缩摘要")
  const response = await apiFetch("/api/sessions/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, summary: content }),
  })
  const payload = await response.json().catch(() => ({})) as {
    error?: string
    summary?: unknown
    contextEstimate?: { messageTokens?: unknown; timestamp?: unknown }
  }
  if (!response.ok) throw new Error(payload.error || `保存压缩摘要失败: HTTP ${response.status}`)
  const summary = normalizeCompactSummary(payload.summary)
  if (!summary) throw new Error("服务端未返回有效的压缩摘要")
  dispatch({ type: "SET_COMPACT_SUMMARY", summary })
  const messageTokens = Number(payload.contextEstimate?.messageTokens)
  const estimate = contextUsageAfterCompaction(currentUsage, messageTokens, summary.timestamp)
  if (estimate) dispatch({ type: "SET_CONTEXT_USAGE", usage: estimate })
  sessionsRef.current = sessionsRef.current.map((session) => session.id === sessionId
    ? { ...session, compactSummary: summary, updatedAt: Date.now() }
    : session)
  dispatch({ type: "SET_SESSIONS", sessions: sessionsRef.current })
}

async function refreshSessions(dispatch: Dispatch<AppAction>, sessionsRef: MutableRefObject<SessionMeta[]>): Promise<void> {
  const response = await apiFetch("/api/sessions")
  if (!response.ok) return
  const sessions = await response.json() as SessionMeta[]
  sessionsRef.current = sessions
  dispatch({ type: "SET_SESSIONS", sessions })
}
