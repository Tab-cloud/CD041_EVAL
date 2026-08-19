import type { MessageRow, SessionRow } from "../store/repository.ts"
import {
  redactInternalImplementationDetails,
  sanitizePersistedAssistantDelivery,
} from "./model-output-policy.ts"
import { formatToolResultForContext } from "./agent-loop-support.ts"

export const CONTEXT_WARNING_RATIO = 0.7
export const CONTEXT_COMPACT_RATIO = 0.8
export const CONTEXT_HARD_RATIO = 0.9
/**
 * Provider context windows constrain tokens, but gateways also cap message
 * cardinality independently. Keep enough headroom for the active tool loop;
 * this is a protocol invariant and must not depend on a model identifier.
 */
export const PROTOCOL_MESSAGE_LIMIT = 512

export type CompactionMode = "manual" | "auto" | "fallback"

export interface CompactSummaryPayload {
  content: string
  timestamp: number
  throughSeq?: number
  mode?: CompactionMode
  originalTokens?: number
  compactedTokens?: number
}

export interface AgentHistoryMessage {
  role: "user" | "assistant" | "tool"
  content: string
  toolCalls?: unknown[]
  toolResults?: unknown[]
  reasoningContent?: string
  reasoningDetails?: Array<Record<string, unknown>>
  originModelId?: string
}

export interface ContextPressure {
  estimatedTokens: number
  inputBudget: number
  ratio: number
  tokenRatio: number
  messageCount: number
  messageLimit: number
  messageRatio: number
  limitingFactor: "tokens" | "messages"
  level: "normal" | "warning" | "compact" | "hard"
  breakdown: { messages: number; attachments: number; overhead: number }
}

const CHARS_PER_TOKEN = 2.5
const MAX_REPLAYED_TOOL_CALLS_PER_ROW = 24
const PRIVATE_ORCHESTRATION_TOOLS = new Set([
  "task", "delegate_dag", "todowrite",
])

export function estimateTokens(value: unknown): number {
  if (value === null || value === undefined) return 0
  const serialized = typeof value === "string" ? value : JSON.stringify(value)
  return Math.ceil(serialized.length / CHARS_PER_TOKEN)
}

export function contextInputBudget(contextWindow: number, maxOutputTokens: number): number {
  const window = Math.max(2_048, Math.floor(contextWindow || 128_000))
  const safetyReserve = Math.max(512, Math.floor(window * 0.05))
  const maximumOutputReserve = Math.max(512, window - safetyReserve - 1_024)
  const outputReserve = Math.min(
    Math.max(512, Math.floor(maxOutputTokens || 4_096)),
    maximumOutputReserve,
  )
  return Math.max(1_024, window - outputReserve - safetyReserve)
}

export function assessContextPressure(options: {
  history: AgentHistoryMessage[]
  incoming: unknown
  contextWindow: number
  maxOutputTokens: number
  attachmentTokens?: number
  overheadTokens?: number
  projectedHistoryTokens?: number
  projectedHistoryMessages?: number
  messageLimit?: number
}): ContextPressure {
  const overheadTokens = options.overheadTokens
    ?? Math.max(2_048, Math.min(24_000, Math.floor(options.contextWindow * 0.12)))
  const messages = (options.projectedHistoryTokens ?? estimateTokens(options.history))
    + estimateTokens(options.incoming)
  const attachments = options.attachmentTokens ?? 0
  const estimatedTokens = overheadTokens + messages + attachments
  const inputBudget = contextInputBudget(options.contextWindow, options.maxOutputTokens)
  const tokenRatio = estimatedTokens / inputBudget
  const messageCount = Math.max(0, Math.floor(options.projectedHistoryMessages ?? options.history.length))
    + (estimateTokens(options.incoming) > 0 ? 1 : 0)
  const messageLimit = Math.max(32, Math.floor(options.messageLimit ?? PROTOCOL_MESSAGE_LIMIT))
  const messageRatio = messageCount / messageLimit
  const ratio = Math.max(tokenRatio, messageRatio)
  const limitingFactor = messageRatio > tokenRatio ? "messages" : "tokens"
  const level = ratio >= CONTEXT_HARD_RATIO ? "hard"
    : ratio >= CONTEXT_COMPACT_RATIO ? "compact"
      : ratio >= CONTEXT_WARNING_RATIO ? "warning" : "normal"
  return {
    estimatedTokens,
    inputBudget,
    ratio,
    tokenRatio,
    messageCount,
    messageLimit,
    messageRatio,
    limitingFactor,
    level,
    breakdown: { messages, attachments, overhead: overheadTokens },
  }
}

export function estimateAttachmentTokens(attachments: Array<{
  kind: "image" | "text" | "binary"
  content?: string
  dataUrl?: string
}>): number {
  return attachments.reduce((total, attachment) => {
    if (attachment.kind === "image") return total + 1_600
    if (attachment.kind === "text") return total + estimateTokens(attachment.content ?? "")
    return total + Math.min(2_000, estimateTokens(attachment.dataUrl ?? ""))
  }, 0)
}

export function parseCompactSummary(session: Pick<SessionRow, "compact_summary" | "compact_at">): CompactSummaryPayload | null {
  if (!session.compact_summary) return null
  try {
    const value = JSON.parse(session.compact_summary) as Partial<CompactSummaryPayload>
    if (typeof value.content !== "string" || !value.content.trim()) return null
    return {
      content: value.content,
      timestamp: typeof value.timestamp === "number" ? value.timestamp : (session.compact_at ?? Date.now()),
      ...(typeof value.throughSeq === "number" ? { throughSeq: value.throughSeq } : {}),
      ...(value.mode === "manual" || value.mode === "auto" || value.mode === "fallback" ? { mode: value.mode } : {}),
      ...(typeof value.originalTokens === "number" ? { originalTokens: value.originalTokens } : {}),
      ...(typeof value.compactedTokens === "number" ? { compactedTokens: value.compactedTokens } : {}),
    }
  } catch {
    return null
  }
}

export function unsummarizedRows(rows: MessageRow[], summary: CompactSummaryPayload | null): MessageRow[] {
  if (!summary) return rows
  if (typeof summary.throughSeq === "number") return rows.filter((row) => row.seq > summary.throughSeq!)
  // 兼容旧版摘要：旧数据没有 throughSeq，使用压缩时间推断摘要覆盖范围。
  return rows.filter((row) => row.timestamp > summary.timestamp)
}

export function rowToAgentHistory(row: MessageRow): AgentHistoryMessage {
  return rowToAgentHistoryMessages(row)[0] ?? {
    role: row.role === "assistant" ? "assistant" : "user",
    content: "",
  }
}

export function buildAgentHistory(rows: MessageRow[], summary: CompactSummaryPayload | null): AgentHistoryMessage[] {
  const prefix: AgentHistoryMessage[] = summary ? [{
    role: "user",
    content: `[早期对话摘要，时间 ${new Date(summary.timestamp).toLocaleString("zh-CN")}]\n${redactInternalImplementationDetails(summary.content)}`,
  }] : []
  return [...prefix, ...unsummarizedRows(rows, summary).flatMap(rowToAgentHistoryMessages)]
}

export function chooseRowsToCompact(rows: MessageRow[], inputBudget: number): { compact: MessageRow[]; keep: MessageRow[] } {
  if (rows.length < 2) return { compact: [], keep: rows }
  const keepBudget = Math.max(800, Math.floor(inputBudget * 0.28))
  let keptTokens = 0
  let split = rows.length
  while (split > 1) {
    const candidate = rows[split - 1]
    const candidateTokens = estimateTokens(rowToAgentHistoryMessages(candidate))
    if (keptTokens > 0 && keptTokens + candidateTokens > keepBudget) break
    keptTokens += candidateTokens
    split--
  }
  // 至少保留最后一条，同时至少压缩一条。
  split = Math.max(1, Math.min(rows.length - 1, split))
  return { compact: rows.slice(0, split), keep: rows.slice(split) }
}

/**
 * Restore completed persisted tool transactions as first-class model history.
 *
 * Tool call/result pairs are the continuation protocol used by OpenCode and
 * Codex: a resumed model must receive the result that the previous turn
 * actually produced. Only complete public pairs are replayed; private
 * orchestration stays hidden, oversized results are bounded, and the LLM
 * adapter may fold a foreign-model transaction into a semantic summary when
 * its native reasoning protocol cannot be replayed safely.
 */
function rowToAgentHistoryMessages(row: MessageRow): AgentHistoryMessage[] {
  const role = row.role === "assistant" || row.role === "tool" ? row.role : "user"
  if (role === "tool") return []
  const content = role === "assistant"
    ? sanitizePersistedAssistantDelivery(row.content)
    : row.content
  if (role !== "assistant") return content ? [{ role, content }] : []

  const calls = parsePersistedArray(row.tool_calls)
    .filter(isPersistedToolCall)
    .filter((call) => !PRIVATE_ORCHESTRATION_TOOLS.has(call.name))
  const results = parsePersistedArray(row.tool_results)
    .filter(isPersistedToolResult)
    .filter((result) => !PRIVATE_ORCHESTRATION_TOOLS.has(result.name))
  const resultsById = new Map(results.map((result) => [result.id, result]))
  const completedCalls = calls
    .filter((call) => resultsById.has(call.id))
    .slice(-MAX_REPLAYED_TOOL_CALLS_PER_ROW)
  const replay: AgentHistoryMessage[] = []

  for (const group of groupPersistedToolCalls(completedCalls)) {
    const first = group[0]!
    replay.push({
      role: "assistant",
      content: "",
      toolCalls: group.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.input,
      })),
      reasoningContent: first.reasoningContent,
      reasoningDetails: first.reasoningDetails,
      originModelId: first.originModelId,
    })
    replay.push({
      role: "tool",
      content: "",
      toolResults: group.map((call) => {
        const result = resultsById.get(call.id)!
        return {
          id: call.id,
          name: result.name,
          result: formatToolResultForContext(result.result, undefined, 8_000, result.name),
        }
      }),
    })
  }
  if (content) replay.push({ role: "assistant", content })
  return replay
}

interface PersistedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  segment: number
  round: number
  reasoningContent?: string
  reasoningDetails?: Array<Record<string, unknown>>
  originModelId?: string
}

interface PersistedToolResult {
  id: string
  name: string
  result: unknown
}

function parsePersistedArray(value: string | null): unknown[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function isPersistedToolCall(value: unknown): value is PersistedToolCall {
  if (!value || typeof value !== "object") return false
  const call = value as Record<string, unknown>
  if (typeof call.id !== "string" || !call.id) return false
  if (typeof call.name !== "string" || !call.name) return false
  if (call.input !== undefined && (!call.input || typeof call.input !== "object" || Array.isArray(call.input))) return false
  return true
}

function isPersistedToolResult(value: unknown): value is PersistedToolResult {
  if (!value || typeof value !== "object") return false
  const result = value as Record<string, unknown>
  return typeof result.id === "string" && Boolean(result.id)
    && typeof result.name === "string" && Boolean(result.name)
    && Object.hasOwn(result, "result")
}

function groupPersistedToolCalls(calls: PersistedToolCall[]): PersistedToolCall[][] {
  const groups: PersistedToolCall[][] = []
  for (const raw of calls) {
    const call: PersistedToolCall = {
      ...raw,
      input: raw.input ?? {},
      segment: Number.isFinite(raw.segment) ? raw.segment : 0,
      round: Number.isFinite(raw.round) ? raw.round : 0,
      reasoningContent: typeof raw.reasoningContent === "string" ? raw.reasoningContent : undefined,
      reasoningDetails: Array.isArray(raw.reasoningDetails)
        ? raw.reasoningDetails.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        : undefined,
      originModelId: typeof raw.originModelId === "string" ? raw.originModelId : undefined,
    }
    const previous = groups.at(-1)
    const previousCall = previous?.[0]
    if (previous && previousCall
      && previousCall.segment === call.segment
      && previousCall.round === call.round) {
      previous.push(call)
    } else {
      groups.push([call])
    }
  }
  return groups
}

function transcriptLine(row: MessageRow): string {
  const parts = [`[seq=${row.seq} role=${row.role}]`, row.content]
  if (row.tool_calls) parts.push(`工具调用: ${row.tool_calls.slice(0, 2_000)}`)
  if (row.tool_results) parts.push(`工具结果: ${row.tool_results.slice(0, 4_000)}`)
  return parts.join("\n")
}

export function buildCompactionTranscript(
  previousSummary: CompactSummaryPayload | null,
  rows: MessageRow[],
  maxChars = 60_000,
): string {
  const previous = previousSummary ? `## 已有压缩摘要\n${previousSummary.content}\n\n` : ""
  const transcript = rows.map(transcriptLine).join("\n\n")
  const available = Math.max(2_000, maxChars - previous.length)
  if (transcript.length <= available) return `${previous}## 新增对话记录\n${transcript}`
  const headSize = Math.floor(available * 0.35)
  const tailSize = available - headSize
  return `${previous}## 新增对话记录\n${transcript.slice(0, headSize)}\n\n[中间内容因摘要请求预算已省略]\n\n${transcript.slice(-tailSize)}`
}

export function buildFallbackSummary(previousSummary: CompactSummaryPayload | null, rows: MessageRow[]): string {
  const excerpts = rows.map((row) => {
    const content = row.content.replace(/\s+/g, " ").trim().slice(0, 240)
    return `- [${row.role}] ${content || "（工具交互或空文本）"}`
  }).join("\n")
  const combined = [
    previousSummary ? `## 之前的摘要\n${previousSummary.content}` : "",
    "## 自动压缩记录（模型摘要失败，已使用安全摘录）",
    excerpts,
  ].filter(Boolean).join("\n\n")
  return combined.slice(0, 8_000)
}

export function trimHistoryToBudget(history: AgentHistoryMessage[], tokenBudget: number): AgentHistoryMessage[] {
  return trimHistoryToCapacity(history, tokenBudget, PROTOCOL_MESSAGE_LIMIT)
}

export function trimHistoryToCapacity(
  history: AgentHistoryMessage[],
  tokenBudget: number,
  messageBudget: number,
): AgentHistoryMessage[] {
  const withinCapacity = (messages: AgentHistoryMessage[]) =>
    estimateTokens(messages) <= tokenBudget && messages.length <= messageBudget
  if (withinCapacity(history)) return history
  const prefix = history[0]?.content.startsWith("[早期对话压缩摘要") ? history[0] : null
  let recent = prefix ? history.slice(1) : [...history]
  while (recent.length > 1 && !withinCapacity(prefix ? [prefix, ...recent] : recent)) {
    // A completed tool transaction is an atomic context unit. Never trim only
    // its assistant call and leave an orphan tool result (or vice versa).
    const remove = recent[0]?.toolCalls?.length && recent[1]?.toolResults?.length ? 2 : 1
    recent = recent.slice(remove)
  }
  while (recent.length > 1 && recent[0]?.role === "tool") recent = recent.slice(1)
  return prefix ? [prefix, ...recent] : recent
}
