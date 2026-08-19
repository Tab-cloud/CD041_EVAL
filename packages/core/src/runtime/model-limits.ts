const DEFAULT_MAX_OUTPUT_TOKENS = 32_768

/**
 * A conservative default for imported model catalogs that do not declare an
 * output limit. Context and output are separate provider limits; one must
 * never be inferred as a fixed fraction of the other after it is configured.
 */
export function defaultModelOutputTokens(contextWindow: number): number {
  const normalizedWindow = Number.isFinite(contextWindow)
    ? Math.max(1_024, Math.floor(contextWindow))
    : 128_000
  return Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.max(512, Math.floor(normalizedWindow / 4)))
}

export function maximumModelOutputTokens(contextWindow: number): number {
  const window = Number.isFinite(contextWindow)
    ? Math.max(2_048, Math.floor(contextWindow))
    : 128_000
  const safetyReserve = Math.max(512, Math.floor(window * 0.05))
  return Math.max(512, window - safetyReserve - 1_024)
}

export function normalizeModelOutputTokens(contextWindow: number, value: unknown): number | null {
  if (value === undefined || value === null) return defaultModelOutputTokens(contextWindow)
  if (!Number.isInteger(value)) return null
  const output = Number(value)
  return output >= 512 && output <= maximumModelOutputTokens(contextWindow) ? output : null
}
