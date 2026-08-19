import type { Dispatch, MutableRefObject } from "react"
import { apiFetch } from "../api"
import type { AppAction, AppState, LogLine, SessionComposerPreferences, SessionMeta } from "../store"
import { cancelSessionCommand } from "../session-commands"
import { deleteSessionArtifact, refreshSessionArtifacts } from "../session-artifacts"
import {
  currentAdmissionInstructionForSession,
  waitingInstructionsForSession,
} from "../instruction-queue-projection"
import { projectInstructionUserMessages } from "../instruction-message-projection"
import { conversationBranchTarget } from "../conversation-branch"
import type { useChat } from "../hooks/useChat"
import type { usePanelResize } from "../hooks/usePanelResize"
import type { useWorkflowNotifications } from "../hooks/useWorkflowNotifications"
import { BottomPanel } from "./BottomPanel"
import { ChatView } from "./ChatView"
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons"
import { LeftSidebar } from "./LeftSidebar"
import { RightPanel } from "./RightPanel"

interface AppWorkspaceProps {
  state: AppState
  dispatch: Dispatch<AppAction>
  activeSessionRef: MutableRefObject<string | null>
  sessionsRef: MutableRefObject<SessionMeta[]>
  chat: ReturnType<typeof useChat>
  resize: ReturnType<typeof usePanelResize>
  workflowNotifications: ReturnType<typeof useWorkflowNotifications>
  composerPreferences: SessionComposerPreferences
  updateComposerPreferences: (patch: Partial<SessionComposerPreferences>) => void
  addLogLine: (target: "terminal" | "serial" | "build", text: string, type: LogLine["type"]) => void
}

export function AppWorkspace({
  state,
  dispatch,
  activeSessionRef,
  sessionsRef,
  chat,
  resize,
  workflowNotifications,
  composerPreferences,
  updateComposerPreferences,
  addLogLine,
}: AppWorkspaceProps) {
  const { send, guide, stop, respondToApproval, respondToQuestion, cancelQuestion } = chat
  const visibleMessages = projectInstructionUserMessages(
    state.messages,
    state.instructionQueue,
    state.activeSessionId,
  )
  const activeRequestId = state.activeSessionId
    ? state.runsBySession[state.activeSessionId]?.requestId
    : undefined
  return (
    <div className="app-body">
      <LeftSidebar
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        isStreaming={state.isStreaming}
        collapsed={state.sidebarCollapsed}
        width={state.sidebarWidth}
        onSelectSession={(id) => {
          activeSessionRef.current = id
          dispatch({ type: "SET_ACTIVE_SESSION", sessionId: id })
        }}
        onNewSession={() => dispatch({ type: "TOGGLE_NEW_TASK" })}
        onArchiveSession={async (id) => {
          try {
            const response = await apiFetch("/api/sessions/archive", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: id }),
            })
            const data = await response.json()
            if (data.success) {
              dispatch({
                type: "SET_SESSIONS",
                sessions: sessionsRef.current.map((session) => (
                  session.id === id ? { ...session, archived: 1, summary: data.summary } : session
                )),
              })
              if (activeSessionRef.current === id) {
                activeSessionRef.current = null
                dispatch({ type: "SET_ACTIVE_SESSION", sessionId: null })
              }
            }
          } catch { /* archiving failure leaves the current session intact */ }
        }}
        onDeleteSession={async (id) => {
          const previousSessions = state.sessions
          dispatch({ type: "SET_SESSIONS", sessions: previousSessions.filter((session) => session.id !== id) })
          if (state.activeSessionId === id) {
            activeSessionRef.current = null
            dispatch({ type: "SET_ACTIVE_SESSION", sessionId: null })
          }
          try {
            const response = await apiFetch(`/api/sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (!data.success) throw new Error(data.error || "删除失败")
            dispatch({ type: "CLEAR_LOG", target: "log", sessionId: id })
          } catch (error) {
            dispatch({ type: "SET_SESSIONS", sessions: previousSessions })
            addLogLine("build", `删除会话失败: ${error}`, "error")
          }
        }}
      />
      {!state.sidebarCollapsed && (
        <div className="resize-handle resize-handle-left" onMouseDown={resize.startResize("left")} />
      )}
      <div className="app-center-wrapper">
        <button
          className="left-collapse-trigger"
          onClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
          title={state.sidebarCollapsed ? "展开左侧面板" : "折叠左侧面板"}
        >
          {state.sidebarCollapsed ? <ChevronRightIcon size={12} /> : <ChevronLeftIcon size={12} />}
        </button>
        <div className="app-center">
          <ChatView
            messages={visibleMessages}
            isStreaming={state.isStreaming}
            activeAgentId={state.activeAgentId}
            onSend={send}
            onResubmit={(source, content, scope, effort) => {
              const branchFrom = conversationBranchTarget(source)
              if (!branchFrom) return false
              return send(content, [], scope, effort, undefined, undefined, branchFrom)
            }}
            onGuide={guide}
            modelConfigs={state.modelConfigs}
            activeModelId={state.activeModelId ?? "auto"}
            workspace={state.workspace}
            defaultScope={composerPreferences.scope}
            defaultEffort={composerPreferences.effort}
            streamStartedAt={state.streamStartedAt}
            isCompacting={state.isCompacting}
            toolStatus={state.toolStatus}
            agentProgress={state.agentProgress}
            workLog={state.workLog}
            connectionStatus={state.connectionStatus}
            reconnectAttempt={state.reconnectAttempt}
            compactSummary={state.compactSummary}
            plan={state.plan}
            pendingApprovals={state.pendingApprovals}
            pendingQuestions={state.pendingQuestions}
            queuedInstructions={waitingInstructionsForSession(
              state.instructionQueue,
              state.activeSessionId,
              activeRequestId,
            )}
            currentInstruction={currentAdmissionInstructionForSession(
              state.instructionQueue,
              state.activeSessionId,
              activeRequestId,
            )}
            onPlanApprove={() => {
              dispatch({ type: "SET_PLAN", plan: state.plan ? { ...state.plan, status: "approved" } : null })
              send("计划已批准，请按计划执行", [], "auto-edit")
            }}
            onPlanReject={(reason) => {
              dispatch({ type: "SET_PLAN", plan: state.plan ? { ...state.plan, status: "rejected" } : null })
              send(reason || "请修改计划，重新规划", [], "plan-mode")
            }}
            onPlanSelect={(index, label, reason) => {
              dispatch({ type: "SET_PLAN", plan: state.plan ? { ...state.plan, status: "approved" } : null })
              send(`选择方案${index + 1}: ${label}${reason ? "。" + reason : ""}，请按该方案执行`, [], "auto-edit")
            }}
            onSwitchModel={(modelId) => {
              dispatch({ type: "SET_MODEL_ID", modelId })
              updateComposerPreferences({ modelId: modelId === "auto" ? null : modelId })
            }}
            onQuestionAnswer={respondToQuestion}
            onQuestionCancel={cancelQuestion}
            onScopeChange={(scope) => {
              updateComposerPreferences({ scope })
              if (!state.isStreaming || !state.activeSessionId) return
              void apiFetch("/api/sessions/runtime-access", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: state.activeSessionId, scope }),
              }).catch(() => undefined)
            }}
            onEffortChange={(effort) => updateComposerPreferences({ effort })}
            onApprovalDecision={respondToApproval}
            onRemoveQueuedInstruction={(instructionId) => {
              const instruction = state.instructionQueue.find((item) => item.id === instructionId)
              if (!instruction) return
              void cancelSessionCommand(instruction.requestId).then(() => {
                dispatch({ type: "REMOVE_QUEUED_INSTRUCTION", instructionId })
              }).catch((error) => {
                addLogLine(
                  "build",
                  `取消排队指令失败: ${error instanceof Error ? error.message : String(error)}`,
                  "error",
                )
              })
            }}
            onAbort={stop}
          />
          {!state.bottomPanelCollapsed && (
            <div className="resize-handle resize-handle-bottom" onMouseDown={resize.startResizeBottom} />
          )}
          <BottomPanel
            activeTab={state.bottomPanelTab}
            terminalOutput={state.terminalOutput}
            serialOutput={state.serialOutput}
            buildOutput={state.buildOutput}
            agentLogOutput={state.activeSessionId ? state.agentLogsBySession[state.activeSessionId] ?? [] : []}
            activeSessionId={state.activeSessionId}
            agents={state.agents}
            contextUsage={state.contextUsage}
            isStreaming={state.isStreaming}
            workspace={state.workspace}
            height={state.bottomPanelHeight}
            collapsed={state.bottomPanelCollapsed}
            serialPort={state.serialPort}
            serialBaudRate={state.serialBaudRate}
            serialConnected={state.serialConnected}
            serialContextEnabled={state.serialContextEnabled}
            onSelectTab={(tab) => {
              dispatch({ type: "SET_BOTTOM_PANEL_TAB", tab })
              if (tab === "office" && state.bottomPanelHeight < 360) {
                dispatch({ type: "SET_BOTTOM_PANEL_HEIGHT", height: 400 })
              }
              if (tab === "store" && state.bottomPanelHeight < 440) {
                dispatch({ type: "SET_BOTTOM_PANEL_HEIGHT", height: 480 })
              }
            }}
            onToggleCollapsed={() => dispatch({ type: "TOGGLE_BOTTOM_PANEL" })}
            onClear={(target) => {
              dispatch({ type: "CLEAR_LOG", target, sessionId: state.activeSessionId ?? undefined })
              if (target === "log" && state.activeSessionId) {
                void apiFetch(`/api/tasks/logs?sessionId=${encodeURIComponent(state.activeSessionId)}`, {
                  method: "DELETE",
                }).catch(() => undefined)
              }
              if (target === "build" && state.activeSessionId) {
                void apiFetch(`/api/build/logs?sessionId=${encodeURIComponent(state.activeSessionId)}`, {
                  method: "DELETE",
                }).catch(() => undefined)
              }
            }}
            onTerminalLog={(line) => dispatch({ type: "ADD_LOG", target: "terminal", line })}
            onSerialLog={(line) => dispatch({ type: "ADD_LOG", target: "serial", line })}
            onSetSerialPort={(port) => dispatch({ type: "SET_SERIAL_PORT", port })}
            onSetSerialBaud={(baud) => dispatch({ type: "SET_SERIAL_BAUD", baud })}
            onSetSerialConnected={(connected) => dispatch({ type: "SET_SERIAL_CONNECTED", connected })}
            onSetSerialContextEnabled={(enabled) => dispatch({ type: "SET_SERIAL_CONTEXT_ENABLED", enabled })}
            onManualCompile={() => send("编译项目", [], "auto-edit")}
            onOfficeSend={(text, scope, agentId) => send(text, [], scope ?? "auto-edit", "on", agentId)}
            onOfficeStop={stop}
            onOfficeCompact={() => send("/compact", [], "auto-edit")}
          />
        </div>
        <button
          className="right-collapse-trigger"
          onClick={() => dispatch({ type: "TOGGLE_RIGHT_PANEL" })}
          title={state.rightPanelCollapsed ? "展开右侧面板" : "折叠右侧面板"}
        >
          {state.rightPanelCollapsed ? <ChevronLeftIcon size={12} /> : <ChevronRightIcon size={12} />}
        </button>
      </div>
      {!state.rightPanelCollapsed && (
        <div className="resize-handle resize-handle-right" onMouseDown={resize.startResize("right")} />
      )}
      <RightPanel
        activeTab={state.rightPanelTab}
        activeSessionId={state.activeSessionId}
        workspace={state.workspace ?? ""}
        workflowNotificationsEnabled={workflowNotifications.enabled}
        onToggleWorkflowNotifications={() => void workflowNotifications.toggle()}
        contextUsage={state.contextUsage}
        todos={state.todos}
        followups={state.followups}
        schematics={state.schematics}
        documents={state.documents}
        compactSummary={state.compactSummary}
        isCompacting={state.isCompacting}
        isStreaming={state.isStreaming}
        workLog={state.workLog}
        collapsed={state.rightPanelCollapsed}
        width={state.rightPanelWidth}
        onSelectTab={(tab) => dispatch({ type: "SET_RIGHT_PANEL_TAB", tab })}
        onRefreshArtifacts={() => state.activeSessionId
          ? refreshSessionArtifacts(state.activeSessionId, dispatch)
          : Promise.resolve()}
        onDeleteArtifacts={async (artifactIds) => {
          if (!state.activeSessionId || artifactIds.length === 0) return
          if (!window.confirm("确认从当前会话资料中删除所选内容？源文件不会被删除。")) return
          for (const artifactId of artifactIds) {
            await deleteSessionArtifact(state.activeSessionId, artifactId, dispatch)
          }
        }}
        onRetryTask={(message, scope, effort, sourceTaskId) => (
          send(message, [], scope, effort, undefined, sourceTaskId)
        )}
      />
    </div>
  )
}
