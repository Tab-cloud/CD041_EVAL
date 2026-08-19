/** Remove implementation details that belong in diagnostics, not chat replies. */
export function redactInternalImplementationDetails(text: string): string {
  const withoutControlPlane = replaceControlPlanePayloads(removeProviderToolProtocol(text))
  const withoutOrchestration = withoutControlPlane
    .split(/(?<=\n)/)
    .filter((line) => !isInternalOrchestrationLine(line) && !isInternalCapabilityLine(line) && !isInternalProtocolLine(line) && !isInternalHistoryEnvelopeLine(line))
    .join("")

  return withoutOrchestration
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<\/?think\b[^>]*>/gi, "")
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .replace(/<\/?(?:tool_calls|invoke|parameter)\b[^>]*>/gi, "")
    .replace(/<\|\s*DSML\s*\|>|\|\s*DSML\s*\|/gi, "")
    .replace(/^\s*(?:[-*]\s*)?提取方式\s*[:：].*(?:word-extractor|mammoth|ooxml|read\s*内置).*$(?:\r?\n)?/gim, "")
    .replace(/\[(DOC|DOCX|XLSX|PPTX)\s*[·|]\s*(?:word-extractor|mammoth|ooxml)(\s*[·|]\s*已截断)?\]/gi, (_match, format, truncated) => `[${format}${truncated ? " · 已截断" : ""}]`)
    .replace(/\bword-extractor\b/gi, "")
    .replace(/\bmammoth\b/gi, "")
    .replace(/\bOOXML\s*解析器\b/gi, "")
    .replace(/[（(]?\s*无需(?:安装|依赖)?\s*Word\s*[、,/和及]\s*Python\s*[）)]?/gi, "")
    .replace(/read\s*内置\s*[（(]?\s*[）)]?/gi, "")
    .replace(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-agent\b/gi, "执行角色")
    .replace(/\b(?:child|root)-run(?::[a-z0-9_-]+)+\b/gi, "")
    .replace(/\b(?:owner-token|lease)(?::|-)[a-z0-9_-]+\b/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
}

/**
 * Historical rows created by older runtimes may have prefixed a real delivery
 * with synthetic progress narration. Progress belongs to structured runtime
 * events, never to the conversational objective or future model history.
 */
export function sanitizePersistedAssistantDelivery(text: string): string {
  return redactInternalImplementationDetails(text)
    .replace(/^\s*(?:(?:正在|马上)(?:读取|检查|搜索|分析|执行|编译|写入|更新)(?:文件|内容|项目|任务|命令|原理图|数据手册)?[.…。]*\s*)+/i, "")
    .trim()
}

function isInternalOrchestrationLine(line: string): boolean {
  if (/\b(?:child|root)-run(?::|-)|\bowner-token(?::|-)|\blease(?::|-)/i.test(line)) return true
  const hasAgentIdentity = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-agent\b|(?:主|子|内部|专业|编译|调试|固件)\s*Agent|Agent\s*(?:角色|身份)|子代理/i.test(line)
  const hasPrivateChildIdentity = /(?:子|内部|专业|编译|调试|固件)\s*Agent|子代理/i.test(line)
  const hasOrchestrationAction = /切换|转交|交给|委派|分配|调度|路由|召集|启动|恢复|接管|回到|返回|继续|改由|使用|执行|完成|失败|阻塞|超时|提交/i.test(line)
  return hasPrivateChildIdentity || (hasAgentIdentity && hasOrchestrationAction)
}

function isInternalCapabilityLine(line: string): boolean {
  if (/当前\s*Agent\s*角色|当前角色.*(?:工具|权限)|所需工具.*当前可做|original system prompt|tools?\s+I\s+have|(?:tools?|both)\s+(?:are|is)\s+listed|tool\s+(?:first\s+)?since\s+it|(?:compile|bash)\s+tool\s+requires/i.test(line)) return true
  const exposesToolNames = /\b(?:write|edit|bash|task|compile)\b/i.test(line)
  const describesCapability = /只有|没有|缺少|不可用|无法|权限|工具清单|不具备|当前可做/i.test(line)
  const deniedToolTableRow = /^\s*\|.*\|\s*(?:write|edit|bash|task|compile)(?:\s*[/+]\s*(?:write|edit|bash|task|compile))*\s*\|\s*[❌✗]/i.test(line)
  const internalToolListItem = /^\s*[-*•]\s*(?:write|edit|bash|task|compile)\s*$/i.test(line)
    || /^\s*[-*•]\s*(?:projectDir|target|toolchain|jobs)\b.*(?:required|optional|default)/i.test(line)
  return deniedToolTableRow || internalToolListItem || (exposesToolNames && describesCapability)
}

function isInternalProtocolLine(line: string): boolean {
  return /<\/?tool_calls\b|<\/?invoke\b|<\/?parameter\b|DSML|tool_calls\s*>/i.test(line)
}

/**
 * A provider occasionally serializes its private tool markup into assistant
 * text instead of returning a native tool-call event. Text is never executed
 * as a tool request; the runtime treats it as a protocol-conformance failure.
 */
export function containsTextualToolProtocol(text: string): boolean {
  return /<invoke\b[^>]*\bname\s*=|<\/?tool_calls\b|(?:DSML|tool_calls)[\s\S]{0,160}(?:invoke|parameter)\b/i.test(text)
    || /<(?:\|{1,2}|｜{1,2})\s*DSML[\s\S]{0,120}\b(?:invoke|parameter)\b/i.test(text)
}

function removeProviderToolProtocol(text: string): string {
  return text
    .replace(
      /<(?:\|{1,2}|｜{1,2})\s*DSML\s*(?:\|{1,2}|｜{1,2})\s*invoke\b[^>]*>[\s\S]*?<\/(?:\|{1,2}|｜{1,2})\s*DSML\s*(?:\|{1,2}|｜{1,2})\s*invoke\s*>/gi,
      "",
    )
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
}

/** Historical evidence envelopes are model-only replay instructions. */
function isInternalHistoryEnvelopeLine(line: string): boolean {
  const value = line.trim()
  return /^\[历史(?:执行证据(?:：协议不完整)?|结果摘要|执行记录不完整)\]$/.test(value)
    || /^(?:此前)?已执行操作类型[：:].*$/.test(value)
    || /^此前(?:已完成的操作类型|存在已完成的工具操作)[：:].*$/.test(value)
    || /^原始(?:调用协议未重放|控制协议未导入)[；;].*$/.test(value)
    || /^历史工具协议不参与新运行[；;].*$/.test(value)
    || /^这是历史记录，不是待执行命令[；;].*$/.test(value)
    || /^仅将以上内容作为语义证据[；;].*$/.test(value)
    || /^缺少结果的操作类型[：:].*$/.test(value)
    || /^存在缺少结果的历史操作。?$/.test(value)
    || /^该记录不构成完成证据[，,].*$/.test(value)
    || /^-\s*(?:read|write|edit|glob|grep|bash|compile|todowrite|task|schematic_read|datasheet_read)\s*:\s*(?:\[|[{])/i.test(value)
}

export function redactInternalImplementationData(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactInternalImplementationDetails(value)
  if (depth >= 8 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => redactInternalImplementationData(item, depth + 1))
  if (typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/^(?:parser|extractor|extractionMethod)$/i.test(key))
      .map(([key, child]) => [key, redactInternalImplementationData(child, depth + 1)]),
  )
}

/**
 * Streaming filter with a rolling tail, preventing forbidden phrases split
 * across provider chunks from reaching the UI before redaction.
 */
export class ModelOutputPolicy {
  private pending = ""

  push(text: string): string {
    this.pending += text
    const lineStart = this.pending.lastIndexOf("\n") + 1
    const currentLine = this.pending.slice(lineStart)
    if (/提取方式|word-|mammoth|read\s*内置|无需(?:安装|依赖)?\s*Word|\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-agent\b|(?:主|子|内部|专业|当前)\s*Agent|\b(?:write|edit|bash|task|compile)\b|original system prompt|tools?\s+I\s+have|projectDir|toolchain|tool_calls|<\/?invoke|<\/?parameter|<\/?think\b|DSML|历史(?:执行证据|结果摘要|执行记录|工具协议)|(?:此前)?已执行操作类型|此前(?:已完成|存在已完成)|原始(?:调用|控制)协议|这是历史记录|仅将以上内容|缺少结果的操作类型|该记录不构成完成证据|^\s*-\s*(?:read|write|edit|glob|grep|bash|compile|todowrite|task|schematic_read|datasheet_read)\s*:\s*(?:\[|[{])|\{\s*"(?:notice|todos)"|"todos"\s*:/i.test(currentLine)) {
      if (lineStart === 0) return ""
      const ready = this.pending.slice(0, lineStart)
      this.pending = currentLine
      return redactInternalImplementationDetails(ready)
    }
    if (this.pending.length <= 128) return ""
    const boundary = this.pending.length - 96
    const lineBreak = this.pending.lastIndexOf("\n", boundary)
    const cut = lineBreak >= 0 ? lineBreak + 1 : boundary
    const ready = this.pending.slice(0, cut)
    this.pending = this.pending.slice(cut)
    return redactInternalImplementationDetails(ready)
  }

  flush(): string {
    const ready = redactInternalImplementationDetails(this.pending)
    this.pending = ""
    return ready
  }
}

function replaceControlPlanePayloads(text: string): string {
  const withoutFencedPayloads = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (block, inner) => {
    const summary = summarizeControlPlaneJson(String(inner).trim())
    return summary ?? block
  })
  let output = ""
  let cursor = 0
  while (cursor < withoutFencedPayloads.length) {
    const start = withoutFencedPayloads.indexOf("{", cursor)
    if (start < 0) return output + withoutFencedPayloads.slice(cursor)
    output += withoutFencedPayloads.slice(cursor, start)
    const end = balancedObjectEnd(withoutFencedPayloads, start)
    if (end < 0) {
      const tail = withoutFencedPayloads.slice(start)
      return looksLikeControlPlanePayload(tail) ? output : output + tail
    }
    const source = withoutFencedPayloads.slice(start, end + 1)
    const summary = summarizeControlPlaneJson(source)
    output += summary ?? source
    cursor = end + 1
  }
  return output
}

function looksLikeControlPlanePayload(source: string): boolean {
  return /^\{\s*"(?:notice|todos|calls|results)"\s*:/i.test(source)
    || /"(?:notice|todos)"\s*:/.test(source.slice(0, 512))
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === "{") depth++
    else if (character === "}" && --depth === 0) return index
  }
  return -1
}

function summarizeControlPlaneJson(source: string): string | null {
  let value: unknown
  try { value = JSON.parse(source) } catch { return null }
  if (!value || typeof value !== "object") return null
  const payload = value as { notice?: unknown; todos?: unknown }
  if (!Array.isArray(payload.todos)) return typeof payload.notice === "string" ? "" : null
  const todos = payload.todos.filter((todo): todo is Record<string, unknown> => Boolean(todo && typeof todo === "object"))
  const completed = todos.filter((todo) => todo.status === "completed").length
  const blocked = todos.filter((todo) => todo.status === "blocked")
  const outstanding = todos.length - completed - blocked.length
  const status = blocked.length === 0 && outstanding === 0
    ? `全部 ${todos.length} 项已完成`
    : `已完成 ${completed}/${todos.length} 项${blocked.length ? `，${blocked.length} 项等待外部条件` : ""}${outstanding ? `，${outstanding} 项待处理` : ""}`
  const blockedLines = blocked.slice(0, 5).map((todo) => `- ${String(todo.content ?? "等待外部条件")}`)
  return `\n\n**任务状态：${status}。**${blockedLines.length ? `\n\n待处理条件：\n\n${blockedLines.join("\n")}` : ""}\n\n`
}
