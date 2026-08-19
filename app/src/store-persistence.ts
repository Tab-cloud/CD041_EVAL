import type { ModelConfig } from "./types"
import type {
  AppState,
  CompactSummary,
  FollowupItem,
  LogLine,
  PlanItem,
  QueuedInstruction,
  TodoItem,
} from "./store"
import { normalizeCompactSummary, normalizeContextUsage } from "./context-state"

const STORAGE_KEY = "eval_model_configs"
const THEME_KEY = "eval_theme"
const ACTIVE_SESSION_KEY = "eval_active_session"
const WORKSPACE_KEY = "eval_workspace"
const SIDEBAR_WIDTH_KEY = "eval_sidebar_width"
const RIGHT_PANEL_WIDTH_KEY = "eval_rightpanel_width"
const BOTTOM_HEIGHT_KEY = "eval_bottom_height"
const CONTEXT_USAGE_PREFIX = "eval_context_"
const TODOS_PREFIX = "eval_todos_"
const FOLLOWUPS_PREFIX = "eval_followups_"
const PLAN_PREFIX = "eval_plan_"
const AGENT_LOG_PREFIX = "eval_agent_log_"
const SERIAL_AI_CONTEXT_KEY = "eval_serial_ai_context"
const INSTRUCTION_QUEUE_KEY = "eval_instruction_queue"

// 面板宽度边界约束
export const SIDEBAR_MIN = 180, SIDEBAR_MAX = 420, SIDEBAR_DEFAULT = 248
export const RIGHT_PANEL_MIN = 240, RIGHT_PANEL_MAX = 520, RIGHT_PANEL_DEFAULT = 320
export const BOTTOM_MIN = 100, BOTTOM_MAX = 500, BOTTOM_DEFAULT = 180
const COMPACT_PREFIX = "eval_compact_"

export function loadModelConfigs(): ModelConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveModelConfigs(configs: ModelConfig[]) {
  // 脱敏：apiKey 不写入 localStorage，防止 XSS / 磁盘读取泄露密钥
  // （真实密钥只存后端 ~/.eval/eval_config.json，前端编辑时输入新值即覆盖）
  const safe = configs.map((c) => ({ ...c, apiKey: "" }))
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(safe)) } catch {}
}

export function loadTheme(): "dark" | "light" {
  try { return (localStorage.getItem(THEME_KEY) as "dark" | "light") ?? "dark" } catch { return "dark" }
}

export function saveTheme(theme: "dark" | "light"): void {
  try { localStorage.setItem(THEME_KEY, theme) } catch {}
}

export function loadActiveSession(): string | null {
  try { return localStorage.getItem(ACTIVE_SESSION_KEY) } catch { return null }
}

export function saveActiveSession(id: string | null) {
  try { if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id); else localStorage.removeItem(ACTIVE_SESSION_KEY) } catch {}
}

export function loadWorkspace(): string | null {
  try { return localStorage.getItem(WORKSPACE_KEY) } catch { return null }
}

export function saveWorkspace(ws: string | null) {
  try { if (ws) localStorage.setItem(WORKSPACE_KEY, ws); else localStorage.removeItem(WORKSPACE_KEY) } catch {}
}

export function loadSidebarWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "")
    if (isNaN(v)) return SIDEBAR_DEFAULT
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, v))
  } catch { return SIDEBAR_DEFAULT }
}

export function saveSidebarWidth(w: number) {
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)) } catch {}
}

export function loadRightPanelWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY) ?? "")
    if (isNaN(v)) return RIGHT_PANEL_DEFAULT
    return Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, v))
  } catch { return RIGHT_PANEL_DEFAULT }
}

export function saveRightPanelWidth(w: number) {
  try { localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(w)) } catch {}
}

export function loadBottomHeight(): number {
  try {
    const v = parseInt(localStorage.getItem(BOTTOM_HEIGHT_KEY) ?? "")
    if (isNaN(v)) return BOTTOM_DEFAULT
    return Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, v))
  } catch { return BOTTOM_DEFAULT }
}

export function saveBottomHeight(h: number) {
  try { localStorage.setItem(BOTTOM_HEIGHT_KEY, String(h)) } catch {}
}

export function loadSerialAiContextEnabled(): boolean {
  try { return localStorage.getItem(SERIAL_AI_CONTEXT_KEY) === "true" } catch { return false }
}

export function saveSerialAiContextEnabled(enabled: boolean): void {
  try { localStorage.setItem(SERIAL_AI_CONTEXT_KEY, String(enabled)) } catch {}
}

export function loadContextUsage(sessionId: string): AppState["contextUsage"] | null {
  try {
    const raw = localStorage.getItem(CONTEXT_USAGE_PREFIX + sessionId)
    return raw ? normalizeContextUsage(JSON.parse(raw)) : null
  } catch { return null }
}

export function saveContextUsage(sessionId: string, usage: AppState["contextUsage"]) {
  try {
    if (usage) localStorage.setItem(CONTEXT_USAGE_PREFIX + sessionId, JSON.stringify(usage))
    else localStorage.removeItem(CONTEXT_USAGE_PREFIX + sessionId)
  } catch {}
}

export function loadTodos(sessionId: string): TodoItem[] {
  try {
    const raw = localStorage.getItem(TODOS_PREFIX + sessionId)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveTodos(sessionId: string, todos: TodoItem[]) {
  try {
    localStorage.setItem(TODOS_PREFIX + sessionId, JSON.stringify(todos))
  } catch {}
}

export function loadFollowups(sessionId: string): FollowupItem[] {
  try {
    const raw = localStorage.getItem(FOLLOWUPS_PREFIX + sessionId)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveFollowups(sessionId: string, followups: FollowupItem[]) {
  try {
    localStorage.setItem(FOLLOWUPS_PREFIX + sessionId, JSON.stringify(followups))
  } catch {}
}

export function loadPlan(sessionId: string): PlanItem | null {
  try {
    const raw = localStorage.getItem(PLAN_PREFIX + sessionId)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function savePlan(sessionId: string, plan: PlanItem | null) {
  try {
    if (plan) localStorage.setItem(PLAN_PREFIX + sessionId, JSON.stringify(plan))
    else localStorage.removeItem(PLAN_PREFIX + sessionId)
  } catch {}
}

export function loadAgentLogs(sessionId: string): LogLine[] {
  try {
    const raw = localStorage.getItem(AGENT_LOG_PREFIX + sessionId)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.slice(-500) : []
  } catch { return [] }
}

export function saveAgentLogs(sessionId: string, logs: LogLine[]): void {
  try {
    localStorage.setItem(AGENT_LOG_PREFIX + sessionId, JSON.stringify(logs.slice(-500)))
  } catch {}
}

export function loadCompactSummary(sessionId: string): CompactSummary | null {
  try {
    const raw = localStorage.getItem(COMPACT_PREFIX + sessionId)
    return raw ? normalizeCompactSummary(JSON.parse(raw)) : null
  } catch { return null }
}

export function saveCompactSummary(sessionId: string, data: CompactSummary | null) {
  try {
    if (data) localStorage.setItem(COMPACT_PREFIX + sessionId, JSON.stringify(data))
    else localStorage.removeItem(COMPACT_PREFIX + sessionId)
  } catch {}
}

export function loadInstructionQueue(): QueuedInstruction[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(INSTRUCTION_QUEUE_KEY) ?? "[]") as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const instruction = item as QueuedInstruction
      if (typeof instruction.id !== "string"
        || typeof instruction.requestId !== "string"
        || typeof instruction.text !== "string") return []
      const serverState = instruction.serverState === "local"
        || instruction.serverState === "pending"
        || instruction.serverState === "processing"
        || instruction.serverState === "accepted"
        ? instruction.serverState
        : "local"
      return [{
        ...instruction,
        attachments: Array.isArray(instruction.attachments)
          ? instruction.attachments.filter((attachment) => Boolean(
              attachment
              && typeof attachment.name === "string"
              && Number.isFinite(attachment.size)
              && (attachment.kind === "image" || attachment.kind === "text" || attachment.kind === "binary"),
            ))
          : [],
        serverState,
      }]
    }).slice(-100)
  } catch {
    return []
  }
}

export function saveInstructionQueue(queue: QueuedInstruction[]): void {
  const recent = queue.slice(-100)
  try {
    localStorage.setItem(INSTRUCTION_QUEUE_KEY, JSON.stringify(recent))
  } catch {
    // WebView localStorage is much smaller than the supported attachment
    // boundary. Persist a visible recovery record instead of silently losing
    // an instruction whose bytes had not reached the durable local service.
    const recoverable = recent.map((instruction) => instruction.serverState === "local"
      && instruction.attachments.some(hasInlineAttachmentBytes)
      ? {
          ...instruction,
          attachments: instruction.attachments.map(stripInlineAttachmentBytes),
          submissionState: "failed" as const,
          submissionError: "应用关闭前附件尚未完成暂存，请重新选择附件",
          submissionRetryAt: undefined,
        }
      : instruction)
    try { localStorage.setItem(INSTRUCTION_QUEUE_KEY, JSON.stringify(recoverable)) } catch {}
  }
}

function hasInlineAttachmentBytes(attachment: QueuedInstruction["attachments"][number]): boolean {
  return typeof attachment.dataUrl === "string"
    || typeof attachment.content === "string"
    || typeof attachment.dataBase64 === "string"
}

function stripInlineAttachmentBytes(
  attachment: QueuedInstruction["attachments"][number],
): QueuedInstruction["attachments"][number] {
  return {
    name: attachment.name,
    path: attachment.path,
    size: attachment.size,
    mime: attachment.mime,
    kind: attachment.kind,
    ...(attachment.uploadId ? { uploadId: attachment.uploadId } : {}),
  }
}
