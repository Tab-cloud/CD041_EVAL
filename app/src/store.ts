import type { AssistantPartEvent, ModelConfig, ChatMessage, AgentInfo, SerialContextPayload } from "./types"
import { applyAssistantPartEvent, settleAssistantPartsForRequest } from "./chat-message-parts"
import { buildModelOptions, resolveModelOptionValue } from "./model-options"
import { updateAssistantMessage } from "./chat-message-state"
import { isActiveRunStatus } from "./session-run-state"
import {
  rewindConversationMessages,
  type ConversationBranchTarget,
} from "./conversation-branch"
export { updateAssistantMessage } from "./chat-message-state"
export { isActiveRunStatus } from "./session-run-state"
import type { CompactSummary, ContextUsageSnapshot } from "./context-state"
export type { CompactSummary, ContextUsageSnapshot } from "./context-state"
import { cacheSystemSettings, loadCachedSystemSettings, type SystemSettings } from "./system-settings"
import {
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  RIGHT_PANEL_MIN,
  RIGHT_PANEL_MAX,
  BOTTOM_MIN,
  BOTTOM_MAX,
  loadModelConfigs,
  saveModelConfigs,
  saveTheme,
  loadActiveSession,
  saveActiveSession,
  loadWorkspace,
  saveWorkspace,
  loadSidebarWidth,
  saveSidebarWidth,
  loadRightPanelWidth,
  saveRightPanelWidth,
  loadBottomHeight,
  saveBottomHeight,
  saveContextUsage,
  saveTodos,
  saveFollowups,
  savePlan,
  saveCompactSummary,
  loadAgentLogs,
  saveAgentLogs,
  loadSerialAiContextEnabled,
  saveSerialAiContextEnabled,
  loadInstructionQueue,
  saveInstructionQueue,
} from "./store-persistence"

export {
  SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT,
  RIGHT_PANEL_MIN, RIGHT_PANEL_MAX, RIGHT_PANEL_DEFAULT,
  BOTTOM_MIN, BOTTOM_MAX, BOTTOM_DEFAULT,
  loadContextUsage, loadTodos, loadFollowups, loadPlan, loadCompactSummary,
} from "./store-persistence"


// ══════════════════════════════════════════════════
// 全局状态 (由 Zustand 风格的纯 store 管理)
// ══════════════════════════════════════════════════

/** 工作日志条目 */
export interface WorkLogEntry {
  id: string
  executionId?: string
  toolCallId?: string
  type: "search" | "edit" | "execute" | "text" | "error"
  label: string            // "探索" / "已编辑" / "执行中" / "错误"
  fileName?: string        // "llm-client.ts"
  filePath?: string        // "embedded-agent/packages/core/src/runtime/"
  linesChanged?: { added: number; removed: number }
  detail?: string          // AI 的文字说明
  diff?: string
  error?: string
  reversible?: boolean
  undoneAt?: number
  timestamp: number
  status: "running" | "done" | "error"
  /** 该步骤曾失败，但根任务随后已成功恢复并完成。仅保留给诊断日志，不作为待处理错误展示。 */
  recovered?: boolean
}

/** 任务清单条目（由 LLM 通过 todowrite 工具维护） */
export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "paused" | "blocked" | "completed"
  priority: "high" | "medium" | "low"
}

/** 不阻塞 Agent 交付、由用户后续完成的实机或外部操作。 */
export interface FollowupItem {
  content: string
  owner: "user"
  category: "hardware-validation" | "external-action"
  reason?: string
}

/** 原理图分析结果（由 schematic_read 工具返回） */
export interface SchematicData {
  artifactId?: string
  analysis: string       // Markdown 格式的分析报告
  filePath: string
  kind?: "page" | "summary"
  pageNumber?: number
  pageCount?: number
  model?: string         // 仅用于内部诊断，不在普通界面展示
  elapsedMs?: number
  focus?: string         // 分析重点
  fileSize?: string
  timestamp?: number     // 分析时间
  sourceHash?: string
  stale?: boolean        // 源文件内容已改变，需要重新分析
}

/** 文档/芯片手册分析结果 */
export interface DocumentItem {
  artifactId?: string
  title: string          // 文档标题
  source: string         // 来源文件路径
  type: string           // "datasheet" | "reference" | "manual" | "other"
  summary: string        // 摘要
  timestamp: number      // 提取时间
  sourceHash?: string
  stale?: boolean
}

/** 执行计划（由 LLM 通过 plan 工具提交） */
export interface PlanOption {
  label: string
  description?: string
}
export interface PlanItem {
  title: string          // 计划标题
  content: string        // Markdown 格式的计划内容
  options?: PlanOption[] // 可选方案列表（多方案选择时使用）
  status: "showing" | "approved" | "rejected"
  timestamp: number
}

export interface ToolApproval {
  kind: "approval"
  id: string
  sessionId?: string
  toolName: string
  reason: string
  target: string
  createdAt: number
  expiresAt: number
}

export interface UserQuestion {
  kind: "question"
  id: string
  sessionId?: string
  question: string
  options: string[]
  allowCustom: boolean
  createdAt: number
}

export interface QueuedInstruction {
  id: string
  requestId: string
  sessionId: string | null
  text: string
  attachments: Array<{
    name: string; path: string; size: number; mime: string; kind: "image" | "text" | "binary"
    dataUrl?: string; content?: string; dataBase64?: string; uploadId?: string
  }>
  scope: "confirm-changes" | "auto-edit" | "plan-mode" | "full-access"
  effort: "on" | "off"
  modelId: string | null
  workingDir: string | null
  agentIdOverride?: string
  resumeTaskId?: string
  branchFrom?: ConversationBranchTarget
  serialContext?: SerialContextPayload
  serverState?: "local" | "pending" | "processing" | "accepted"
  submissionState?: "sending" | "retrying" | "failed"
  submissionError?: string
  submissionRetryAt?: number
  /** Monotonic FIFO position assigned by the durable session command store. */
  sessionSeq?: number
  taskId?: string
  createdAt: number
}

export interface SessionRunProjection {
  sessionId: string
  requestId: string
  taskId?: string
  status: string
  startedAt: number
  updatedAt: number
  lastEventSeq?: number
}

export interface AppState {
  // ─── Agent ───
  activeAgentId: string
  agents: AgentInfo[]

  // ─── Sessions ───
  sessions: SessionMeta[]
  activeSessionId: string | null
  sessionRestoreNonce: number
  /** Ignores stale queue responses that were created before a completed /clear. */
  conversationClearedAtBySession: Record<string, number>
  /** A newly bound live session owns its optimistic timeline until explicitly selected. */
  liveBoundSessionId: string | null

  // ─── Chat ───
  messages: ChatMessage[]
  isStreaming: boolean
  isCompacting: boolean                // 正在执行手动或自动上下文压缩
  streamStartedAt: number | null       // 用户发送消息的时间戳（用于计时）
  toolStatus: { name: string; input?: Record<string, unknown> } | null  // 当前执行的工具
  agentProgress: { phase: "queued" | "model" | "tools" | "repair" | "finalization"; step: number; maxSteps: number; toolCount?: number } | null
  workLog: WorkLogEntry[]              // 工作日志（操作记录）
  contextUsage: ContextUsageSnapshot | null
  todos: TodoItem[]                     // LLM 通过 todowrite 工具维护的任务清单
  followups: FollowupItem[]              // 用户后续手动验证，不参与任务完成度
  schematics: SchematicData[]           // 原理图分析结果列表
  documents: DocumentItem[]             // 芯片手册/文档分析结果
  artifactRevision: number              // 后端资料仓库的会话级单调版本
  compactSummary: CompactSummary | null // 上下文压缩摘要
  plan: PlanItem | null                // 执行计划（由 plan 工具提交）
  pendingApprovals: ToolApproval[] // 按创建时间排序的待审批队列
  pendingQuestions: UserQuestion[] // 应用级阻塞问题，不随当前会话切换而隐藏
  instructionQueue: QueuedInstruction[] // 当前执行完成后按顺序发送
  /** False until /api/session-commands has supplied the authoritative queue. */
  sessionCommandsHydrated: boolean
  runsBySession: Record<string, SessionRunProjection>

  // ─── Model ───
  modelConfigs: ModelConfig[]
  activeModelId: string | null
  connectionStatus: "connected" | "disconnected" | "connecting"
  reconnectAttempt: number           // 重连次数，0 表示未在重连

  // ─── UI ───
  theme: "dark" | "light"
  showModelConfig: boolean
  showSystemSettings: boolean
  showNewTask: boolean
  workspace: string | null
  updateAvailable: boolean
  showProjectPanel: boolean
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean
  bottomPanelCollapsed: boolean
  systemSettings: SystemSettings
  sidebarWidth: number               // 左侧栏宽度（可拖拽调整）
  rightPanelWidth: number            // 右侧栏宽度（可拖拽调整）
  bottomPanelHeight: number          // 底部面板高度（可拖拽调整）
  rightPanelTab: "context" | "changes" | "tasks" | "schematic" | "docs"
  showSlashHelp: boolean
  bottomPanelTab: BottomPanelTab
  serialPort: string | null        // 当前选择的串口 "COM3"
  serialBaudRate: number           // 波特率 115200
  serialConnected: boolean         // 是否正在监听
  serialContextEnabled: boolean    // 下一轮对话是否附加最近串口数据

  // ─── Project ───

  // ─── Bottom Output ───
  terminalOutput: LogLine[]
  serialOutput: LogLine[]
  buildOutput: LogLine[]
  buildLogsBySession: Record<string, LogLine[]>
  agentLogsBySession: Record<string, LogLine[]>
}

export interface SessionMeta {
  id: string
  title: string
  agentId: string
  projectPath?: string | null
  createdAt: number
  updatedAt: number
  archived?: number
  summary?: string | null
  compactSummary?: CompactSummary | null   // 后端权威来源
  schematics?: SchematicData[]       // 原理图分析结果列表
  documents?: DocumentItem[]         // 文档分析结果列表
  artifactRevision?: number
  composerPreferences?: SessionComposerPreferences
}

export interface SessionComposerPreferences {
  modelId: string | null
  effort: "on" | "off"
  scope: "confirm-changes" | "auto-edit" | "plan-mode" | "full-access"
}

export interface LogLine {
  id?: string
  text: string
  type: "stdout" | "stderr" | "info" | "error" | "warning" | "success" | "timestamp" | "model" | "tool" | "result"
  timestamp: number
}

export type BottomPanelTab = "terminal" | "serial" | "build" | "download" | "log" | "office" | "store"

// ══════════════════════════════════════════════════
// Actions
// ══════════════════════════════════════════════════

export type AppAction =
  | { type: "SET_AGENT"; agentId: string }
  | { type: "SET_AGENTS"; agents: AgentInfo[] }
  | { type: "SET_CONNECTION"; status: AppState["connectionStatus"] }
  | { type: "ADD_MESSAGE"; message: ChatMessage }
  | { type: "UPSERT_REQUEST_MESSAGE"; message: ChatMessage & { requestId: string } }
  | { type: "ADD_GUIDANCE_MESSAGE"; message: ChatMessage & { requestId: string }; activeRequestId?: string }
  | { type: "UPDATE_LAST_MESSAGE"; content: string }
  | { type: "APPLY_ASSISTANT_PART"; event: AssistantPartEvent }
  | { type: "SETTLE_ASSISTANT_PARTS"; requestId: string; outcome: "completed" | "discarded"; timestamp: number }
  | { type: "SET_STREAMING"; streaming: boolean; sessionId?: string | null; requestId?: string; taskId?: string }
  | { type: "UPSERT_SESSION_RUN"; run: SessionRunProjection }
  | { type: "REMOVE_SESSION_RUN"; sessionId: string; taskId?: string }
  | { type: "SET_MODEL_CONFIGS"; configs: ModelConfig[] }
  | { type: "TOGGLE_MODEL_CONFIG" }
  | { type: "TOGGLE_SYSTEM_SETTINGS" }
  | { type: "SET_SYSTEM_SETTINGS"; settings: SystemSettings }
  | { type: "TOGGLE_NEW_TASK" }
  | { type: "SET_WORKSPACE"; workspace: string | null }
  | { type: "SET_UPDATE_AVAILABLE"; available: boolean }
  | { type: "SET_RIGHT_PANEL_TAB"; tab: AppState["rightPanelTab"] }
  | { type: "SET_BOTTOM_PANEL_TAB"; tab: AppState["bottomPanelTab"] }
  | { type: "SET_SERIAL_PORT"; port: string | null }
  | { type: "SET_SERIAL_BAUD"; baud: number }
  | { type: "SET_SERIAL_CONNECTED"; connected: boolean }
  | { type: "SET_SERIAL_CONTEXT_ENABLED"; enabled: boolean }
  | { type: "ADD_LOG"; target: BottomPanelTab; line: LogLine; sessionId?: string }
  | { type: "CLEAR_LOG"; target: BottomPanelTab; sessionId?: string }
  | { type: "SET_AGENT_LOGS"; sessionId: string; logs: LogLine[] }
  | { type: "SET_BUILD_LOGS"; sessionId: string; logs: LogLine[] }
  | { type: "CREATE_SESSION"; session: SessionMeta }
  | { type: "BIND_ACTIVE_SESSION"; sessionId: string }
  | { type: "SET_ACTIVE_SESSION"; sessionId: string | null }
  | { type: "SET_SESSIONS"; sessions: SessionMeta[] }
  | { type: "UPDATE_SESSION_PREFERENCES"; sessionId: string; preferences: SessionComposerPreferences }
  | { type: "SET_MESSAGES"; messages: ChatMessage[] }
  | { type: "CLEAR_SESSION_CONVERSATION"; sessionId: string; artifactRevision: number; clearedAt: number }
  | { type: "APPLY_CONVERSATION_BRANCH"; sessionId: string; target: ConversationBranchTarget }
  | { type: "TOGGLE_THEME" }
  | { type: "SET_MODEL_ID"; modelId: string }
  | { type: "SET_RECONNECT"; attempt: number }
  | { type: "SET_STREAM_START"; time: number | null }
  | { type: "SET_TOOL_STATUS"; tool: { name: string; input?: Record<string, unknown> } | null }
  | { type: "SET_AGENT_PROGRESS"; progress: AppState["agentProgress"] }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "TOGGLE_RIGHT_PANEL" }
  | { type: "TOGGLE_BOTTOM_PANEL" }
  | { type: "SET_BOTTOM_PANEL_COLLAPSED"; collapsed: boolean }
  | { type: "SET_SIDEBAR_WIDTH"; width: number }
  | { type: "SET_RIGHT_PANEL_WIDTH"; width: number }
  | { type: "SET_BOTTOM_PANEL_HEIGHT"; height: number }
  | { type: "SET_CONTEXT_USAGE"; usage: AppState["contextUsage"] }
  | { type: "SET_TODOS"; todos: TodoItem[] }
  | { type: "SET_FOLLOWUPS"; followups: FollowupItem[] }
  | { type: "PAUSE_RUNNING_TODOS" }
  | { type: "CLEAR_TODOS" }
  | { type: "SET_PLAN"; plan: PlanItem | null }
  | { type: "SET_PLAN_STATUS"; status: PlanItem["status"] }
  | { type: "CLEAR_PLAN" }
  | { type: "SET_PENDING_APPROVALS"; approvals: ToolApproval[] }
  | { type: "UPSERT_PENDING_APPROVAL"; approval: ToolApproval }
  | { type: "REMOVE_PENDING_APPROVAL"; approvalId: string }
  | { type: "SET_PENDING_QUESTIONS"; questions: UserQuestion[] }
  | { type: "UPSERT_PENDING_QUESTION"; question: UserQuestion }
  | { type: "REMOVE_PENDING_QUESTION"; questionId: string }
  | { type: "ENQUEUE_INSTRUCTION"; instruction: QueuedInstruction }
  | { type: "UPSERT_QUEUED_INSTRUCTION"; instruction: QueuedInstruction }
  | { type: "SYNC_SERVER_COMMANDS"; instructions: QueuedInstruction[] }
  | { type: "REMOVE_QUEUED_INSTRUCTION"; instructionId: string }
  | { type: "SET_ARTIFACTS"; revision: number; schematics: SchematicData[]; documents: DocumentItem[] }
  | { type: "SET_SLASH_HELP"; show: boolean }
  | { type: "SET_COMPACTING"; compacting: boolean }
  | { type: "SET_COMPACT_SUMMARY"; summary: CompactSummary | null }
  | { type: "ADD_WORK_LOG"; entry: WorkLogEntry }
  | { type: "SET_WORK_LOG"; entries: WorkLogEntry[] }
  | { type: "UPDATE_WORK_LOG"; id: string; updates: Partial<WorkLogEntry> }
  | { type: "FAIL_RUNNING_WORK_LOGS"; error: string }
  | { type: "MARK_WORK_LOG_ERRORS_RECOVERED" }
  | { type: "CLEAR_WORK_LOG" }

// ══════════════════════════════════════════════════
// Persistence helpers
// ══════════════════════════════════════════════════

// ══════════════════════════════════════════════════
// Initial State
// ══════════════════════════════════════════════════

export function createInitialState(): AppState {
  const systemSettings = loadCachedSystemSettings()
  const activeSessionId = systemSettings.restoreLastSession ? loadActiveSession() : null
  return {
    activeAgentId: "auto",
    agents: [], // 从 /api/agents 动态加载
    sessions: [],
    activeSessionId,
    sessionRestoreNonce: 0,
    conversationClearedAtBySession: {},
    liveBoundSessionId: null,
    messages: [],
    isStreaming: false,
    isCompacting: false,
    streamStartedAt: null,
    toolStatus: null,
    agentProgress: null,
    workLog: [],
    contextUsage: null,
    todos: [],
    followups: [],
    schematics: [],
    documents: [],
    artifactRevision: 0,
    compactSummary: null,
    plan: null,
    pendingApprovals: [],
    pendingQuestions: [],
    instructionQueue: loadInstructionQueue(),
    sessionCommandsHydrated: false,
    runsBySession: {},
    modelConfigs: loadModelConfigs(),
    activeModelId: null,
    connectionStatus: "disconnected",
    reconnectAttempt: 0,
    theme: systemSettings.theme,
    showModelConfig: false,
    showSystemSettings: false,
    showNewTask: false,
    workspace: loadWorkspace(),
    updateAvailable: false,
    showProjectPanel: true,
    sidebarCollapsed: false,
    rightPanelCollapsed: true,
    bottomPanelCollapsed: true,
    systemSettings,
    sidebarWidth: loadSidebarWidth(),
    rightPanelWidth: loadRightPanelWidth(),
    bottomPanelHeight: loadBottomHeight(),
    rightPanelTab: "context",
    showSlashHelp: false,
    bottomPanelTab: "terminal",
    serialPort: null,
    serialBaudRate: systemSettings.serialBaudRate,
    serialConnected: false,
    serialContextEnabled: loadSerialAiContextEnabled(),
    terminalOutput: [],
    serialOutput: [],
    buildOutput: [],
    buildLogsBySession: {},
    agentLogsBySession: activeSessionId ? { [activeSessionId]: loadAgentLogs(activeSessionId) } : {},
  }
}

// ══════════════════════════════════════════════════
// Reducer
// ══════════════════════════════════════════════════

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_AGENT":
      return { ...state, activeAgentId: action.agentId }

    case "SET_AGENTS":
      return { ...state, agents: action.agents }

    case "SET_CONNECTION":
      return { ...state, connectionStatus: action.status, reconnectAttempt: action.status === "connected" ? 0 : state.reconnectAttempt }

    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] }

    case "UPSERT_REQUEST_MESSAGE": {
      const index = state.messages.findIndex((message) =>
        message.requestId === action.message.requestId
        && message.role === action.message.role)
      if (index < 0) return { ...state, messages: [...state.messages, action.message] }
      const current = state.messages[index]
      const messages = [...state.messages]
      messages[index] = {
        ...current,
        ...action.message,
        content: action.message.content || current.content,
        attachments: action.message.attachments?.length
          ? action.message.attachments
          : current.attachments,
        deliveryFiles: action.message.deliveryFiles
          ? action.message.deliveryFiles
          : current.deliveryFiles,
        timestamp: current.timestamp,
      }
      return { ...state, messages }
    }

    case "ADD_GUIDANCE_MESSAGE": {
      const existing = state.messages.findIndex((message) =>
        message.requestId === action.message.requestId
        && message.role === "user")
      if (existing >= 0) {
        const messages = [...state.messages]
        messages[existing] = { ...messages[existing], ...action.message }
        return { ...state, messages }
      }
      const before = action.activeRequestId
        ? state.messages.findIndex((message) =>
            message.role === "assistant" && message.requestId === action.activeRequestId)
        : -1
      const messages = [...state.messages]
      if (before >= 0) messages.splice(before, 0, action.message)
      else messages.push(action.message)
      return { ...state, messages }
    }

    case "UPDATE_LAST_MESSAGE": {
      return { ...state, messages: updateAssistantMessage(state.messages, action.content) }
    }

    case "SET_STREAMING":
      if (action.sessionId) {
        const previous = state.runsBySession?.[action.sessionId]
        if (!action.streaming && action.taskId && previous?.taskId
          && previous.taskId !== action.taskId) return state
        const runsBySession = action.streaming
          ? {
              ...state.runsBySession,
              [action.sessionId]: {
                sessionId: action.sessionId,
                requestId: action.requestId ?? previous?.requestId ?? "",
                taskId: action.taskId ?? previous?.taskId,
                status: previous?.status ?? "running",
                startedAt: previous?.startedAt ?? Date.now(),
                updatedAt: Date.now(),
                lastEventSeq: previous?.lastEventSeq,
              },
            }
          : Object.fromEntries(Object.entries(state.runsBySession ?? {})
              .filter(([sessionId]) => sessionId !== action.sessionId))
        return {
          ...state,
          runsBySession,
          isStreaming: state.activeSessionId === action.sessionId ? action.streaming : state.isStreaming,
        }
      }
      return { ...state, isStreaming: action.streaming }

    case "UPSERT_SESSION_RUN": {
      const clearedAt = state.conversationClearedAtBySession?.[action.run.sessionId] ?? 0
      if (action.run.startedAt < clearedAt) return state
      const runsBySession = {
        ...state.runsBySession,
        [action.run.sessionId]: {
          ...state.runsBySession?.[action.run.sessionId],
          ...action.run,
        },
      }
      return {
        ...state,
        runsBySession,
        isStreaming: state.activeSessionId === action.run.sessionId
          ? isActiveRunStatus(action.run.status)
          : state.isStreaming,
        streamStartedAt: state.activeSessionId === action.run.sessionId
          ? action.run.startedAt
          : state.streamStartedAt,
      }
    }

    case "REMOVE_SESSION_RUN": {
      const current = state.runsBySession?.[action.sessionId]
      if (action.taskId && current?.taskId && current.taskId !== action.taskId) return state
      const runsBySession = Object.fromEntries(Object.entries(state.runsBySession ?? {})
        .filter(([sessionId]) => sessionId !== action.sessionId))
      return {
        ...state,
        runsBySession,
        isStreaming: state.activeSessionId === action.sessionId ? false : state.isStreaming,
        streamStartedAt: state.activeSessionId === action.sessionId ? null : state.streamStartedAt,
      }
    }

    case "SET_MODEL_CONFIGS": {
      const options = buildModelOptions(action.configs)
      const validSelection = (value: string | null | undefined): string | null => {
        if (!value || value === "auto") return null
        return resolveModelOptionValue(options, value) || null
      }
      const sessions = state.sessions.map((session) => {
        if (!session.composerPreferences?.modelId) return session
        const modelId = validSelection(session.composerPreferences.modelId)
        return modelId === session.composerPreferences.modelId
          ? session
          : { ...session, composerPreferences: { ...session.composerPreferences, modelId } }
      })
      saveModelConfigs(action.configs)
      return {
        ...state,
        modelConfigs: action.configs,
        sessions,
        activeModelId: validSelection(state.activeModelId),
      }
    }

    case "TOGGLE_MODEL_CONFIG":
      return { ...state, showModelConfig: !state.showModelConfig }

    case "TOGGLE_SYSTEM_SETTINGS":
      return { ...state, showSystemSettings: !state.showSystemSettings }

    case "SET_SYSTEM_SETTINGS":
      cacheSystemSettings(action.settings)
      saveTheme(action.settings.theme)
      return {
        ...state,
        systemSettings: action.settings,
        theme: action.settings.theme,
        serialBaudRate: action.settings.serialBaudRate,
      }

    case "TOGGLE_NEW_TASK":
      return { ...state, showNewTask: !state.showNewTask }

    case "SET_WORKSPACE":
      saveWorkspace(action.workspace)
      return { ...state, workspace: action.workspace }

    case "SET_UPDATE_AVAILABLE":
      return { ...state, updateAvailable: action.available }

    case "SET_RIGHT_PANEL_TAB":
      return { ...state, rightPanelTab: action.tab }

    case "SET_BOTTOM_PANEL_TAB":
      return { ...state, bottomPanelTab: action.tab }

    case "SET_SERIAL_PORT":
      return { ...state, serialPort: action.port }

    case "SET_SERIAL_BAUD":
      return { ...state, serialBaudRate: action.baud }

    case "SET_SERIAL_CONNECTED":
      return { ...state, serialConnected: action.connected }

    case "SET_SERIAL_CONTEXT_ENABLED":
      saveSerialAiContextEnabled(action.enabled)
      return { ...state, serialContextEnabled: action.enabled }

    case "ADD_LOG": {
      if (action.target === "log") {
        const sessionId = action.sessionId ?? state.activeSessionId
        if (!sessionId) return state
        const logs = [...(state.agentLogsBySession[sessionId] ?? []), {
          ...action.line,
          text: action.line.text.slice(0, 4_000),
        }].slice(-500)
        saveAgentLogs(sessionId, logs)
        return { ...state, agentLogsBySession: { ...state.agentLogsBySession, [sessionId]: logs } }
      }
      if (action.target === "build") {
        const sessionId = action.sessionId ?? state.activeSessionId
        if (!sessionId) {
          return {
            ...state,
            buildOutput: mergeLogLines(
              state.buildOutput,
              [{ ...action.line, text: action.line.text.slice(0, 4_000) }],
              2_000,
            ),
          }
        }
        const logs = mergeLogLines(
          state.buildLogsBySession[sessionId] ?? [],
          [{ ...action.line, text: action.line.text.slice(0, 4_000) }],
          2_000,
        )
        return {
          ...state,
          buildLogsBySession: { ...state.buildLogsBySession, [sessionId]: logs },
          buildOutput: state.activeSessionId === sessionId ? logs : state.buildOutput,
        }
      }
      const key = action.target === "terminal" ? "terminalOutput"
        : action.target === "serial" ? "serialOutput"
        : null
      if (!key) return state
      return { ...state, [key]: [...state[key], { ...action.line, text: action.line.text.slice(0, 4_000) }].slice(-2_000) }
    }

    case "CLEAR_LOG": {
      if (action.target === "log") {
        const sessionId = action.sessionId ?? state.activeSessionId
        if (!sessionId) return state
        saveAgentLogs(sessionId, [])
        return { ...state, agentLogsBySession: { ...state.agentLogsBySession, [sessionId]: [] } }
      }
      if (action.target === "build") {
        const sessionId = action.sessionId ?? state.activeSessionId
        if (!sessionId) return { ...state, buildOutput: [] }
        return {
          ...state,
          buildLogsBySession: { ...state.buildLogsBySession, [sessionId]: [] },
          buildOutput: state.activeSessionId === sessionId ? [] : state.buildOutput,
        }
      }
      const key = action.target === "terminal" ? "terminalOutput"
        : action.target === "serial" ? "serialOutput"
        : null
      if (!key) return state
      return { ...state, [key]: [] }
    }

    case "SET_AGENT_LOGS": {
      const logs = action.logs.slice(-500)
      saveAgentLogs(action.sessionId, logs)
      return { ...state, agentLogsBySession: { ...state.agentLogsBySession, [action.sessionId]: logs } }
    }

    case "SET_BUILD_LOGS": {
      const logs = mergeLogLines([], action.logs, 2_000)
      return {
        ...state,
        buildLogsBySession: { ...state.buildLogsBySession, [action.sessionId]: logs },
        buildOutput: state.activeSessionId === action.sessionId ? logs : state.buildOutput,
      }
    }

    case "CREATE_SESSION":
      saveActiveSession(action.session.id)
      return {
        ...state,
        sessions: [...state.sessions, action.session],
        activeSessionId: action.session.id,
        liveBoundSessionId: action.session.id,
        isStreaming: isActiveRunStatus(state.runsBySession?.[action.session.id]?.status),
        activeModelId: action.session.composerPreferences?.modelId ?? null,
        messages: [],
        workLog: [],
        agentProgress: null,
        isCompacting: false,
        contextUsage: null,
        todos: [],
        followups: [],
        schematics: [],
        documents: [],
        artifactRevision: 0,
        compactSummary: null,
        buildOutput: [],
        buildLogsBySession: { ...state.buildLogsBySession, [action.session.id]: [] },
        agentLogsBySession: { ...state.agentLogsBySession, [action.session.id]: [] },
      }

    case "SET_ACTIVE_SESSION":
      saveActiveSession(action.sessionId)
      {
        const selectedSession = state.sessions.find((session) => session.id === action.sessionId)
      // 切换会话时立即清空所有会话级状态，防止上一会话残留泄漏到下一会话
      // 历史消息由 onSelectSession 异步加载后通过 SET_MESSAGES 覆盖
      return {
        ...state,
        activeSessionId: action.sessionId,
        isStreaming: action.sessionId
          ? isActiveRunStatus(state.runsBySession?.[action.sessionId]?.status)
          : false,
        streamStartedAt: action.sessionId
          ? state.runsBySession?.[action.sessionId]?.startedAt ?? null
          : null,
        sessionRestoreNonce: state.sessionRestoreNonce + 1,
        liveBoundSessionId: null,
        activeModelId: selectedSession?.composerPreferences?.modelId ?? null,
        messages: [],
        workLog: [],
        contextUsage: null,
        todos: [],
        followups: [],
        isCompacting: false,
        toolStatus: null,
        agentProgress: null,
        schematics: [],
        documents: [],
        artifactRevision: 0,
        compactSummary: null,
        plan: null,
        buildOutput: action.sessionId ? state.buildLogsBySession[action.sessionId] ?? [] : [],
        agentLogsBySession: action.sessionId && !state.agentLogsBySession[action.sessionId]
          ? { ...state.agentLogsBySession, [action.sessionId]: loadAgentLogs(action.sessionId) }
          : state.agentLogsBySession,
      }
      }

    case "BIND_ACTIVE_SESSION":
      saveActiveSession(action.sessionId)
      {
        const logs = state.buildLogsBySession?.[action.sessionId] ?? state.buildOutput ?? []
        return {
          ...state,
          activeSessionId: action.sessionId,
          liveBoundSessionId: action.sessionId,
          isStreaming: isActiveRunStatus(state.runsBySession?.[action.sessionId]?.status),
          streamStartedAt: state.runsBySession?.[action.sessionId]?.startedAt ?? state.streamStartedAt,
          buildOutput: logs,
          buildLogsBySession: { ...state.buildLogsBySession, [action.sessionId]: logs },
          instructionQueue: (state.instructionQueue ?? []).map((instruction) => instruction.sessionId === null
            ? { ...instruction, sessionId: action.sessionId }
            : instruction),
        }
      }

    case "SET_SESSIONS": {
      const requested = action.sessions.find((session) => session.id === state.activeSessionId)
      const active = requested ?? (state.systemSettings.restoreLastSession
        ? action.sessions.find((session) => !session.archived) ?? null
        : null)
      const activeSessionId = active?.id ?? null
      if (activeSessionId !== state.activeSessionId) saveActiveSession(activeSessionId)
      return {
        ...state,
        sessions: action.sessions,
        activeSessionId,
        activeModelId: active?.composerPreferences?.modelId ?? state.activeModelId,
      }
    }

    case "UPDATE_SESSION_PREFERENCES":
      return {
        ...state,
        sessions: state.sessions.map((session) => session.id === action.sessionId
          ? { ...session, composerPreferences: action.preferences }
          : session),
        activeModelId: state.activeSessionId === action.sessionId
          ? action.preferences.modelId
          : state.activeModelId,
      }

    case "SET_MESSAGES":
      return { ...state, messages: action.messages }

    case "CLEAR_SESSION_CONVERSATION": {
      saveCompactSummary(action.sessionId, null)
      saveContextUsage(action.sessionId, null)
      saveTodos(action.sessionId, [])
      saveFollowups(action.sessionId, [])
      savePlan(action.sessionId, null)
      saveAgentLogs(action.sessionId, [])
      const instructionQueue = state.instructionQueue.filter((item) => item.sessionId !== action.sessionId)
      saveInstructionQueue(instructionQueue)
      const runsBySession = Object.fromEntries(Object.entries(state.runsBySession)
        .filter(([sessionId]) => sessionId !== action.sessionId))
      const sessions = state.sessions.map((session) => session.id === action.sessionId
        ? {
            ...session,
            compactSummary: null,
            artifactRevision: action.artifactRevision,
            schematics: [],
            documents: [],
          }
        : session)
      const common = {
        ...state,
        sessions,
        instructionQueue,
        runsBySession,
        pendingApprovals: state.pendingApprovals.filter((item) => item.sessionId !== action.sessionId),
        pendingQuestions: state.pendingQuestions.filter((item) => item.sessionId !== action.sessionId),
        buildLogsBySession: { ...state.buildLogsBySession, [action.sessionId]: [] },
        agentLogsBySession: { ...state.agentLogsBySession, [action.sessionId]: [] },
        conversationClearedAtBySession: {
          ...state.conversationClearedAtBySession,
          [action.sessionId]: Math.max(
            state.conversationClearedAtBySession?.[action.sessionId] ?? 0,
            action.clearedAt,
          ),
        },
      }
      if (state.activeSessionId !== action.sessionId) return common
      return {
        ...common,
        sessionRestoreNonce: state.sessionRestoreNonce + 1,
        liveBoundSessionId: null,
        messages: [],
        isStreaming: false,
        isCompacting: false,
        streamStartedAt: null,
        toolStatus: null,
        agentProgress: null,
        workLog: [],
        contextUsage: null,
        todos: [],
        followups: [],
        schematics: [],
        documents: [],
        artifactRevision: action.artifactRevision,
        compactSummary: null,
        plan: null,
        buildOutput: [],
      }
    }

    case "APPLY_CONVERSATION_BRANCH": {
      saveCompactSummary(action.sessionId, null)
      saveContextUsage(action.sessionId, null)
      saveTodos(action.sessionId, [])
      saveFollowups(action.sessionId, [])
      savePlan(action.sessionId, null)
      const sessions = state.sessions.map((session) => session.id === action.sessionId
        ? { ...session, compactSummary: null }
        : session)
      if (state.activeSessionId !== action.sessionId) return { ...state, sessions }
      return {
        ...state,
        sessions,
        messages: rewindConversationMessages(state.messages, action.target),
        compactSummary: null,
        contextUsage: null,
        todos: [],
        followups: [],
        plan: null,
        workLog: [],
        toolStatus: null,
        agentProgress: null,
        isCompacting: false,
      }
    }

    case "APPLY_ASSISTANT_PART":
      return { ...state, messages: applyAssistantPartEvent(state.messages, action.event) }

    case "SETTLE_ASSISTANT_PARTS":
      return {
        ...state,
        messages: settleAssistantPartsForRequest(
          state.messages,
          action.requestId,
          action.outcome,
          action.timestamp,
        ),
      }

    case "TOGGLE_THEME": {
      const next: SystemSettings["theme"] = state.theme === "dark" ? "light" : "dark"
      saveTheme(next)
      const systemSettings = { ...state.systemSettings, theme: next }
      cacheSystemSettings(systemSettings)
      return { ...state, theme: next, systemSettings }
    }

    case "SET_MODEL_ID":
      return { ...state, activeModelId: action.modelId }

    case "SET_RECONNECT":
      return { ...state, reconnectAttempt: action.attempt, connectionStatus: "connecting" }

    case "SET_STREAM_START":
      return { ...state, streamStartedAt: action.time }

    case "SET_TOOL_STATUS":
      return { ...state, toolStatus: action.tool }

    case "SET_AGENT_PROGRESS":
      return { ...state, agentProgress: action.progress }

    case "TOGGLE_SIDEBAR":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed }

    case "TOGGLE_RIGHT_PANEL":
      return { ...state, rightPanelCollapsed: !state.rightPanelCollapsed }

    case "TOGGLE_BOTTOM_PANEL":
      return { ...state, bottomPanelCollapsed: !state.bottomPanelCollapsed }

    case "SET_BOTTOM_PANEL_COLLAPSED":
      return { ...state, bottomPanelCollapsed: action.collapsed }

    case "SET_SIDEBAR_WIDTH": {
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, action.width))
      saveSidebarWidth(w)
      return { ...state, sidebarWidth: w }
    }

    case "SET_RIGHT_PANEL_WIDTH": {
      const w = Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, action.width))
      saveRightPanelWidth(w)
      return { ...state, rightPanelWidth: w }
    }

    case "SET_BOTTOM_PANEL_HEIGHT": {
      const h = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, action.height))
      saveBottomHeight(h)
      return { ...state, bottomPanelHeight: h }
    }

    case "ADD_WORK_LOG":
      return {
        ...state,
        workLog: [...state.workLog.filter((entry) => entry.id !== action.entry.id), action.entry].slice(-100),
      }

    case "SET_WORK_LOG":
      return { ...state, workLog: action.entries.slice(-100) }

    case "UPDATE_WORK_LOG":
      return {
        ...state,
        workLog: state.workLog.map(e =>
          e.id === action.id ? { ...e, ...action.updates } : e
        ),
      }

    case "FAIL_RUNNING_WORK_LOGS":
      return {
        ...state,
        workLog: state.workLog.map((entry) => entry.status === "running"
          ? { ...entry, status: "error", error: action.error }
          : entry),
      }

    case "MARK_WORK_LOG_ERRORS_RECOVERED":
      return {
        ...state,
        workLog: state.workLog.map((entry) => entry.status === "error"
          ? { ...entry, recovered: true }
          : entry),
      }

    case "CLEAR_WORK_LOG":
      return { ...state, workLog: [] }

    case "SET_CONTEXT_USAGE":
      // 持久化到 localStorage，按 sessionId 索引
      if (state.activeSessionId) saveContextUsage(state.activeSessionId, action.usage)
      return { ...state, contextUsage: action.usage }

    case "SET_TODOS":
      if (state.activeSessionId) saveTodos(state.activeSessionId, action.todos)
      return { ...state, todos: action.todos }

    case "SET_FOLLOWUPS":
      if (state.activeSessionId) saveFollowups(state.activeSessionId, action.followups)
      return { ...state, followups: action.followups }

    case "PAUSE_RUNNING_TODOS": {
      const todos = state.todos.map((todo) => todo.status === "in_progress" ? { ...todo, status: "paused" as const } : todo)
      if (state.activeSessionId) saveTodos(state.activeSessionId, todos)
      return { ...state, todos }
    }

    case "CLEAR_TODOS":
      if (state.activeSessionId) saveTodos(state.activeSessionId, [])
      if (state.activeSessionId) saveFollowups(state.activeSessionId, [])
      return { ...state, todos: [], followups: [] }

    case "SET_PLAN":
      if (state.activeSessionId) savePlan(state.activeSessionId, action.plan)
      return { ...state, plan: action.plan }

    case "SET_PLAN_STATUS": {
      const plan = state.plan ? { ...state.plan, status: action.status } : null
      if (state.activeSessionId) savePlan(state.activeSessionId, plan)
      return { ...state, plan }
    }

    case "CLEAR_PLAN":
      if (state.activeSessionId) savePlan(state.activeSessionId, null)
      return { ...state, plan: null }

    case "SET_PENDING_APPROVALS":
      return {
        ...state,
        pendingApprovals: action.approvals
          .filter((item) => !item.sessionId
            || item.createdAt >= (state.conversationClearedAtBySession?.[item.sessionId] ?? 0))
          .sort((a, b) => a.createdAt - b.createdAt),
      }

    case "UPSERT_PENDING_APPROVAL": {
      if (action.approval.sessionId
        && action.approval.createdAt < (state.conversationClearedAtBySession?.[action.approval.sessionId] ?? 0)) {
        return state
      }
      const approvals = state.pendingApprovals.filter((item) => item.id !== action.approval.id)
      approvals.push(action.approval)
      approvals.sort((a, b) => a.createdAt - b.createdAt)
      return { ...state, pendingApprovals: approvals }
    }

    case "REMOVE_PENDING_APPROVAL":
      return { ...state, pendingApprovals: state.pendingApprovals.filter((item) => item.id !== action.approvalId) }

    case "SET_PENDING_QUESTIONS":
      return {
        ...state,
        pendingQuestions: action.questions
          .filter((item) => !item.sessionId
            || item.createdAt >= (state.conversationClearedAtBySession?.[item.sessionId] ?? 0))
          .sort((a, b) => a.createdAt - b.createdAt),
      }

    case "UPSERT_PENDING_QUESTION": {
      if (action.question.sessionId
        && action.question.createdAt < (state.conversationClearedAtBySession?.[action.question.sessionId] ?? 0)) {
        return state
      }
      const questions = state.pendingQuestions.filter((item) => item.id !== action.question.id)
      questions.push(action.question)
      questions.sort((a, b) => a.createdAt - b.createdAt)
      return { ...state, pendingQuestions: questions }
    }

    case "REMOVE_PENDING_QUESTION":
      return { ...state, pendingQuestions: state.pendingQuestions.filter((item) => item.id !== action.questionId) }

    case "ENQUEUE_INSTRUCTION":
      {
        const instructionQueue = [...state.instructionQueue.filter((item) => item.requestId !== action.instruction.requestId), action.instruction]
        saveInstructionQueue(instructionQueue)
        return { ...state, instructionQueue }
      }

    case "UPSERT_QUEUED_INSTRUCTION": {
      const clearedAt = action.instruction.sessionId
        ? state.conversationClearedAtBySession?.[action.instruction.sessionId] ?? 0
        : 0
      if (action.instruction.createdAt < clearedAt) return state
      if (!state.instructionQueue.some((item) => item.requestId === action.instruction.requestId)) return state
      const instructionQueue = [...state.instructionQueue.filter((item) => item.requestId !== action.instruction.requestId), action.instruction]
        .sort((left, right) => left.createdAt - right.createdAt)
      saveInstructionQueue(instructionQueue)
      return { ...state, instructionQueue }
    }

    case "SYNC_SERVER_COMMANDS": {
      // The pending-list endpoint intentionally omits terminal commands. Keep
      // unresolved local projections until their command stream proves the
      // terminal state (or returns 404), otherwise a fast backend failure can
      // disappear between POST acceptance and the first SSE attachment.
      const byRequest = new Map(state.instructionQueue
        .map((item) => [item.requestId, item]))
      for (const instruction of action.instructions) {
        const clearedAt = instruction.sessionId
          ? state.conversationClearedAtBySession?.[instruction.sessionId] ?? 0
          : 0
        if (instruction.createdAt < clearedAt) continue
        byRequest.set(instruction.requestId, {
          ...byRequest.get(instruction.requestId),
          ...instruction,
        })
      }
      const instructionQueue = [...byRequest.values()]
        .sort((left, right) => left.createdAt - right.createdAt)
      saveInstructionQueue(instructionQueue)
      return { ...state, instructionQueue, sessionCommandsHydrated: true }
    }

    case "REMOVE_QUEUED_INSTRUCTION":
      {
        const instructionQueue = state.instructionQueue.filter((item) => item.id !== action.instructionId)
        saveInstructionQueue(instructionQueue)
        return { ...state, instructionQueue }
      }

    case "SET_ARTIFACTS":
      return {
        ...state,
        artifactRevision: action.revision,
        schematics: action.schematics,
        documents: action.documents,
        sessions: state.activeSessionId
          ? state.sessions.map((session) => session.id === state.activeSessionId
            ? {
                ...session,
                artifactRevision: action.revision,
                schematics: action.schematics,
                documents: action.documents,
              }
            : session)
          : state.sessions,
      }

    case "SET_SLASH_HELP":
      return { ...state, showSlashHelp: action.show }

    case "SET_COMPACTING":
      return { ...state, isCompacting: action.compacting }

    case "SET_COMPACT_SUMMARY":
      console.log("[store] SET_COMPACT_SUMMARY sessionId=", state.activeSessionId, "summary=", action.summary ? action.summary.content.slice(0, 50) : null)
      if (state.activeSessionId) saveCompactSummary(state.activeSessionId, action.summary)
      return { ...state, compactSummary: action.summary }

    default:
      return state
  }
}

function mergeLogLines(existing: LogLine[], incoming: LogLine[], limit: number): LogLine[] {
  const merged = [...existing]
  const indexes = new Map<string, number>()
  merged.forEach((line, index) => {
    if (line.id) indexes.set(line.id, index)
  })
  for (const line of incoming) {
    if (line.id && indexes.has(line.id)) {
      merged[indexes.get(line.id)!] = line
      continue
    }
    if (line.id) indexes.set(line.id, merged.length)
    merged.push(line)
  }
  return merged.slice(-limit)
}
