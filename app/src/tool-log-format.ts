export function formatToolLogValue(value: unknown, maxLength: number): string {
  return formatAgentLogValue(compactToolLogValue(value), maxLength)
}

export function formatToolResultLog(name: string, value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (typeof record.error === "string") return formatToolLogValue({ error: record.error, diagnostic: record.diagnostic }, 1_200)
    if (name === "schematic_read" && typeof record.analysis === "string") {
      const page = Number.isInteger(record.pageNumber) ? `第 ${record.pageNumber} 页` : "原理图"
      const verification = record.verification && typeof record.verification === "object"
        ? String((record.verification as Record<string, unknown>).verdict ?? "")
        : ""
      const review = verification === "CONFIRMED" ? "独立复核一致"
        : verification === "CONFLICT" ? "发现证据冲突，已保留供审查"
          : verification === "INSUFFICIENT" ? "局部证据不足，继续按不确定项审查" : "分析完成"
      return `${page}${review}；完整分析 ${record.analysis.length} 字符已送入后续审查上下文。`
    }
    if (typeof record.summary === "string") return record.summary.slice(0, 1_200)
    const fileKeys = Object.entries(record).filter(([key, item]) => /[\\/]|\.[a-z0-9]{1,8}$/i.test(key) && typeof item === "string")
    if (fileKeys.length > 0) return `${name} 已处理 ${fileKeys.length} 个文件：${fileKeys.slice(0, 8).map(([key]) => key).join("、")}`
  }
  return formatToolLogValue(value, 1_200)
}

function formatAgentLogValue(value: unknown, maxLength: number): string {
  let text: string
  try {
    text = JSON.stringify(value, (key, current) => /api[-_]?key|authorization|token|secret|password|cookie/i.test(key)
      ? "[已隐藏]"
      : current) ?? String(value)
  } catch {
    text = String(value)
  }
  text = text.replace(/(Bearer\s+)[^\s"']+/gi, "$1[已隐藏]")
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function compactToolLogValue(value: unknown, depth = 0, key = ""): unknown {
  if (typeof value === "string") {
    if (value.length <= 240) return value
    const kind = /content|code|source|output|data|text/i.test(key) || /[\\/]|\.[a-z0-9]{1,8}$/i.test(key) ? "文本内容" : "长文本"
    return `[${kind} ${value.length} 字符]`
  }
  if (depth >= 3) return "[嵌套数据]"
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactToolLogValue(item, depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([entryKey, item]) => [entryKey, compactToolLogValue(item, depth + 1, entryKey)]))
  }
  return value
}
