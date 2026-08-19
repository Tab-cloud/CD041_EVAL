const MAX_STRING_CHARS = 16_000
const MAX_ARRAY_ITEMS = 200
const MAX_OBJECT_KEYS = 200

/**
 * Persist a valid JSON document under a hard byte budget. Oversized values are
 * reduced structurally; JSON text is never sliced because that creates an
 * unreplayable event.
 */
export function stringifyBoundedJson(value: unknown, maxBytes: number): string {
  const serialized = safeStringify(value)
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized

  const bounded = boundValue(value, 0)
  const envelope = isRecord(bounded)
    ? {
        ...bounded,
        _persistence: {
          truncated: true,
          originalBytes: Buffer.byteLength(serialized, "utf8"),
          reason: "payload-exceeded-persistence-budget",
        },
      }
    : {
        value: bounded,
        _persistence: {
          truncated: true,
          originalBytes: Buffer.byteLength(serialized, "utf8"),
          reason: "payload-exceeded-persistence-budget",
        },
      }
  const candidate = safeStringify(envelope)
  if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate
  return JSON.stringify({
    _persistence: {
      truncated: true,
      originalBytes: Buffer.byteLength(serialized, "utf8"),
      reason: "payload-exceeded-persistence-budget",
    },
  })
}

function boundValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_CHARS) return value
    const half = Math.floor(MAX_STRING_CHARS / 2)
    return `${value.slice(0, half)}\n…[持久化时省略 ${value.length - MAX_STRING_CHARS} 字符]…\n${value.slice(-half)}`
  }
  if (value === null || typeof value !== "object") return value
  if (depth >= 8) return "[达到持久化深度上限]"
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundValue(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[省略 ${value.length - MAX_ARRAY_ITEMS} 项]`)
    return items
  }
  const result: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = boundValue(item, depth + 1)
  }
  if (entries.length > MAX_OBJECT_KEYS) result._omittedKeys = entries.length - MAX_OBJECT_KEYS
  return result
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return JSON.stringify({
      _persistence: {
        truncated: true,
        reason: "payload-not-serializable",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      },
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
