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
  scope: "all" | "session"
  sessionId?: string
  startDate: string
  endDate: string
  days: TokenUsageDay[]
  totals: Omit<TokenUsageDay, "date">
}

export function normalizeTokenUsageHeatmap(value: unknown): TokenUsageHeatmap | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  if (input.scope !== "all" && input.scope !== "session") return null
  if (typeof input.startDate !== "string" || typeof input.endDate !== "string") return null
  if (!Array.isArray(input.days) || !input.totals || typeof input.totals !== "object") return null
  const days = input.days.map(normalizeDay).filter((day): day is TokenUsageDay => Boolean(day))
  if (days.length !== input.days.length) return null
  const totals = normalizeTotals(input.totals)
  if (!totals) return null
  return {
    scope: input.scope,
    ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
    startDate: input.startDate,
    endDate: input.endDate,
    days,
    totals,
  }
}

export function tokenHeatLevel(tokens: number, maximum: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maximum <= 0) return 0
  const ratio = Math.log1p(tokens) / Math.log1p(maximum)
  if (ratio <= 0.35) return 1
  if (ratio <= 0.58) return 2
  if (ratio <= 0.79) return 3
  return 4
}

export function heatmapSlots(days: TokenUsageDay[]): Array<TokenUsageDay | null> {
  if (days.length === 0) return []
  const first = parseLocalDate(days[0]!.date)
  const mondayIndex = (first.getDay() + 6) % 7
  return [
    ...Array.from({ length: mondayIndex }, () => null),
    ...days,
  ]
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${trim(tokens / 1_000_000_000)}B`
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}K`
  return String(Math.max(0, Math.round(tokens)))
}

function normalizeDay(value: unknown): TokenUsageDay | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  if (typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null
  const totals = normalizeTotals(input)
  return totals ? { date: input.date, ...totals } : null
}

function normalizeTotals(value: unknown): Omit<TokenUsageDay, "date"> | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  const fields = [
    "promptTokens",
    "completionTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "totalTokens",
    "calls",
    "actualCalls",
    "estimatedCalls",
  ] as const
  const normalized = {} as Record<(typeof fields)[number], number>
  for (const field of fields) {
    const number = input[field]
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return null
    normalized[field] = Math.round(number)
  }
  return normalized
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year!, month! - 1, day!)
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
    .replace(/\.?0+$/, "")
}
