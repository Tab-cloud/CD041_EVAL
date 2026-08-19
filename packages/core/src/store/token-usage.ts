import { getDb } from "./database.ts"

export type TokenUsageSource = "actual" | "estimated"
export type TokenUsageScope = "agent" | "tool"
export type TokenHeatmapScope = "all" | "session"

export interface TokenUsageEventInput {
  id: string
  attemptId: string
  runId: string
  sessionId: string
  agentId: string
  scope: TokenUsageScope
  operation: string
  segment: number
  step: number
  providerId: string
  modelId: string
  modelName: string
  promptTokens: number
  completionTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  source: TokenUsageSource
  occurredAt?: number
  localDay?: string
}

export interface TokenUsageDay {
  date: string
  promptTokens: number
  completionTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalTokens: number
  calls: number
  actualCalls: number
  estimatedCalls: number
}

export interface TokenUsageHeatmap {
  scope: TokenHeatmapScope
  sessionId?: string
  startDate: string
  endDate: string
  days: TokenUsageDay[]
  totals: Omit<TokenUsageDay, "date">
}

interface DailyRow {
  local_day: string
  prompt_tokens: number
  completion_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  calls: number
  actual_calls: number
  estimated_calls: number
}

export const TokenUsageRepo = {
  /**
   * The event ID is the billing idempotency key. A replayed SSE/model finish
   * may safely call this method again without inflating either daily rollup.
   */
  record(input: TokenUsageEventInput): boolean {
    const event = normalizeEvent(input)
    return getDb().transaction(() => {
      const inserted = getDb().run(
        `INSERT OR IGNORE INTO token_usage_events
         (id, attempt_id, run_id, session_id, agent_id, scope, operation,
          segment, step, provider_id, model_id, model_name, prompt_tokens,
          completion_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          source, occurred_at, local_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id, event.attemptId, event.runId, event.sessionId, event.agentId,
          event.scope, event.operation, event.segment, event.step,
          event.providerId, event.modelId, event.modelName,
          event.promptTokens, event.completionTokens,
          event.cacheCreationInputTokens, event.cacheReadInputTokens,
          event.source, event.occurredAt, event.localDay,
        ],
      )
      if (inserted.changes === 0) return false
      upsertDaily("all", "*", event)
      upsertDaily("session", event.sessionId, event)
      return true
    }).immediate()
  },

  heatmap(input?: {
    days?: number
    scope?: TokenHeatmapScope
    sessionId?: string
    now?: number
  }): TokenUsageHeatmap {
    const count = clampInteger(input?.days ?? 91, 7, 366)
    const scope = input?.scope === "session" ? "session" : "all"
    const sessionId = scope === "session" ? input?.sessionId?.trim() : undefined
    if (scope === "session" && !sessionId) {
      throw new Error("按会话统计 Token 时必须提供 sessionId")
    }
    const end = startOfLocalDay(input?.now ?? Date.now())
    const start = addLocalDays(end, -(count - 1))
    const startDate = formatLocalDay(start)
    const endDate = formatLocalDay(end)
    const rows = getDb().query(
      `SELECT local_day, prompt_tokens, completion_tokens,
              cache_creation_input_tokens, cache_read_input_tokens,
              calls, actual_calls, estimated_calls
       FROM token_usage_daily
       WHERE scope_type = ? AND scope_id = ?
         AND local_day BETWEEN ? AND ?
       ORDER BY local_day ASC`,
    ).all(scope, scope === "all" ? "*" : sessionId!, startDate, endDate) as DailyRow[]
    const byDay = new Map(rows.map((row) => [row.local_day, row]))
    const days = Array.from({ length: count }, (_, index) => {
      const date = formatLocalDay(addLocalDays(start, index))
      return toDay(date, byDay.get(date))
    })
    const totals = days.reduce<Omit<TokenUsageDay, "date">>((sum, day) => ({
      promptTokens: sum.promptTokens + day.promptTokens,
      completionTokens: sum.completionTokens + day.completionTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + day.cacheCreationInputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + day.cacheReadInputTokens,
      totalTokens: sum.totalTokens + day.totalTokens,
      calls: sum.calls + day.calls,
      actualCalls: sum.actualCalls + day.actualCalls,
      estimatedCalls: sum.estimatedCalls + day.estimatedCalls,
    }), emptyTotals())
    return {
      scope,
      ...(sessionId ? { sessionId } : {}),
      startDate,
      endDate,
      days,
      totals,
    }
  },

  clear(): void {
    getDb().transaction(() => {
      getDb().run("DELETE FROM token_usage_events")
      getDb().run("DELETE FROM token_usage_daily")
    }).immediate()
  },
}

function upsertDaily(
  scopeType: TokenHeatmapScope,
  scopeId: string,
  event: ReturnType<typeof normalizeEvent>,
): void {
  const actual = event.source === "actual" ? 1 : 0
  const estimated = event.source === "estimated" ? 1 : 0
  getDb().run(
    `INSERT INTO token_usage_daily
     (local_day, scope_type, scope_id, prompt_tokens, completion_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, calls,
      actual_calls, estimated_calls, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(local_day, scope_type, scope_id) DO UPDATE SET
       prompt_tokens = prompt_tokens + excluded.prompt_tokens,
       completion_tokens = completion_tokens + excluded.completion_tokens,
       cache_creation_input_tokens =
         cache_creation_input_tokens + excluded.cache_creation_input_tokens,
       cache_read_input_tokens =
         cache_read_input_tokens + excluded.cache_read_input_tokens,
       calls = calls + 1,
       actual_calls = actual_calls + excluded.actual_calls,
       estimated_calls = estimated_calls + excluded.estimated_calls,
       updated_at = excluded.updated_at`,
    [
      event.localDay, scopeType, scopeId,
      event.promptTokens, event.completionTokens,
      event.cacheCreationInputTokens, event.cacheReadInputTokens,
      actual, estimated, event.occurredAt,
    ],
  )
}

function normalizeEvent(input: TokenUsageEventInput) {
  const occurredAt = finiteInteger(input.occurredAt ?? Date.now())
  return {
    ...input,
    id: required(input.id, "id"),
    attemptId: required(input.attemptId, "attemptId"),
    runId: required(input.runId, "runId"),
    sessionId: required(input.sessionId, "sessionId"),
    agentId: required(input.agentId, "agentId"),
    operation: required(input.operation, "operation"),
    providerId: required(input.providerId, "providerId"),
    modelId: required(input.modelId, "modelId"),
    modelName: required(input.modelName, "modelName"),
    segment: finiteInteger(input.segment),
    step: finiteInteger(input.step),
    promptTokens: nonNegativeInteger(input.promptTokens),
    completionTokens: nonNegativeInteger(input.completionTokens),
    cacheCreationInputTokens: nonNegativeInteger(input.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: nonNegativeInteger(input.cacheReadInputTokens ?? 0),
    occurredAt,
    localDay: input.localDay && /^\d{4}-\d{2}-\d{2}$/.test(input.localDay)
      ? input.localDay
      : formatLocalDay(occurredAt),
  }
}

function toDay(date: string, row?: DailyRow): TokenUsageDay {
  const promptTokens = row?.prompt_tokens ?? 0
  const completionTokens = row?.completion_tokens ?? 0
  return {
    date,
    promptTokens,
    completionTokens,
    cacheCreationInputTokens: row?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: row?.cache_read_input_tokens ?? 0,
    totalTokens: promptTokens + completionTokens,
    calls: row?.calls ?? 0,
    actualCalls: row?.actual_calls ?? 0,
    estimatedCalls: row?.estimated_calls ?? 0,
  }
}

function emptyTotals(): Omit<TokenUsageDay, "date"> {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    calls: 0,
    actualCalls: 0,
    estimatedCalls: 0,
  }
}

function required(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Token 用量事件缺少 ${name}`)
  return normalized
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

function finiteInteger(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, finiteInteger(value)))
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

function formatLocalDay(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
