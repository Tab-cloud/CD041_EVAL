export interface ContextUsageSnapshot {
  used: number
  total: number
  breakdown: {
    messages: number
    systemTools: number
    skills: number
    systemPrompt: number
    other: number
  }
  usage?: { promptTokens: number; completionTokens: number }
  protocolMessages?: { used: number; total: number }
  updatedAt?: number
  source?: "model" | "preflight-estimate" | "compaction-estimate"
  estimated?: boolean
}

export interface CompactSummary {
  content: string
  timestamp: number
  throughSeq?: number
  mode?: "manual" | "auto" | "fallback"
  originalTokens?: number
  compactedTokens?: number
}

export function normalizeContextUsage(value: unknown): ContextUsageSnapshot | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Partial<ContextUsageSnapshot>
  if (!finiteNonNegative(raw.used) || !finitePositive(raw.total) || !raw.breakdown || typeof raw.breakdown !== "object") return null
  const breakdown = raw.breakdown as Record<string, unknown>
  const normalized: ContextUsageSnapshot["breakdown"] = {
    messages: numberOrZero(breakdown.messages),
    systemTools: numberOrZero(breakdown.systemTools),
    skills: numberOrZero(breakdown.skills),
    systemPrompt: numberOrZero(breakdown.systemPrompt),
    other: numberOrZero(breakdown.other),
  }
  return {
    used: Math.round(raw.used),
    total: Math.round(raw.total),
    breakdown: normalized,
    ...(raw.usage && finiteNonNegative(raw.usage.promptTokens) && finiteNonNegative(raw.usage.completionTokens)
      ? { usage: { promptTokens: Math.round(raw.usage.promptTokens), completionTokens: Math.round(raw.usage.completionTokens) } }
      : {}),
    ...(raw.protocolMessages
      && finiteNonNegative(raw.protocolMessages.used)
      && finitePositive(raw.protocolMessages.total)
      ? { protocolMessages: {
          used: Math.round(raw.protocolMessages.used),
          total: Math.round(raw.protocolMessages.total),
        } }
      : {}),
    ...(finitePositive(raw.updatedAt) ? { updatedAt: Math.round(raw.updatedAt) } : {}),
    ...(raw.source === "model" || raw.source === "preflight-estimate" || raw.source === "compaction-estimate"
      ? { source: raw.source }
      : {}),
    ...(raw.estimated === true ? { estimated: true } : {}),
  }
}

export function normalizeCompactSummary(value: unknown): CompactSummary | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Partial<CompactSummary>
  if (typeof raw.content !== "string" || !raw.content.trim() || !finitePositive(raw.timestamp)) return null
  return {
    content: raw.content,
    timestamp: Math.round(raw.timestamp),
    ...(finiteNonNegative(raw.throughSeq) ? { throughSeq: Math.round(raw.throughSeq) } : {}),
    ...(raw.mode === "manual" || raw.mode === "auto" || raw.mode === "fallback" ? { mode: raw.mode } : {}),
    ...(finiteNonNegative(raw.originalTokens) ? { originalTokens: Math.round(raw.originalTokens) } : {}),
    ...(finiteNonNegative(raw.compactedTokens) ? { compactedTokens: Math.round(raw.compactedTokens) } : {}),
  }
}

/** Reconcile a server-side compact summary with the last measured request. */
export function contextUsageAfterCompaction(
  current: ContextUsageSnapshot | null,
  messageTokens: number,
  timestamp: number,
): ContextUsageSnapshot | null {
  if (!current || !finiteNonNegative(messageTokens)) return null
  const breakdown = { ...current.breakdown, messages: Math.round(messageTokens) }
  const used = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
  return {
    used,
    total: current.total,
    breakdown,
    updatedAt: timestamp,
    source: "compaction-estimate",
    estimated: true,
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function numberOrZero(value: unknown): number {
  return finiteNonNegative(value) ? Math.round(value) : 0
}
