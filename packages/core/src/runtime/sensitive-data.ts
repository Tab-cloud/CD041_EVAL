const SENSITIVE_KEY = /(?:api.?key|authorization|cookie|credential|password|secret|token)/i

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

export function redactSensitiveData(value: unknown, key = "", depth = 0): unknown {
  if (isSensitiveKey(key)) return "[已隐藏]"
  if (depth >= 8) return "[内容过深]"
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactSensitiveData(item, "", depth + 1))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 200)
    .map(([childKey, childValue]) => [childKey, redactSensitiveData(childValue, childKey, depth + 1)]))
}

export function redactSensitiveRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactSensitiveData(value) as Record<string, unknown>
}
