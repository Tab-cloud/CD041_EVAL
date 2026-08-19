export type ModelFailureClass =
  | "quota"
  | "authentication"
  | "transient-request"
  | "transient-stream"
  | "cancelled"
  | "protocol"
  | "request"

export interface ModelFailureDecision {
  kind: ModelFailureClass
  persistenceKind: "quota" | "fault-domain" | "request" | "cancelled"
  retryable: boolean
  externalBlocker: boolean
  faultDomainFailure: boolean
  summary: string
}

/**
 * One authoritative classification for retry, circuit breaking, persistence,
 * terminal state, and public summaries. Keeping these decisions together
 * prevents the same transport timeout from being "retryable" in one layer and
 * a terminal task failure in another.
 */
export function classifyModelFailure(error: string | undefined): ModelFailureDecision {
  const source = error?.trim() ?? ""
  if (isQuotaError(source)) {
    const resetAt = quotaResetAt(source)
    return {
      kind: "quota",
      persistenceKind: "quota",
      retryable: false,
      externalBlocker: true,
      faultDomainFailure: false,
      summary: resetAt
        ? `模型配额已耗尽，预计 ${formatResetAt(resetAt)} 恢复`
        : "模型配额已耗尽，需等待额度恢复",
    }
  }
  if (/(401|403|invalid api key|unauthorized|模型服务认证失败|认证失败)/i.test(source)) {
    return decision("authentication", "request", false, true, false, "模型服务认证失败")
  }
  if (/(用户取消|任务取消|cancelled by user|operation was aborted)/i.test(source)) {
    return decision("cancelled", "cancelled", false, false, false, "模型调用已取消")
  }
  if (isStreamFailure(source)) {
    return decision("transient-stream", "fault-domain", true, true, true, streamSummary(source))
  }
  if (isTransientRequestFailure(source)) {
    return decision("transient-request", "fault-domain", true, true, true, requestSummary(source))
  }
  if (/(context|token).*(limit|length|maximum|exceed)|上下文.*超/i.test(source)) {
    return decision("request", "request", false, false, false, "请求上下文超过模型限制")
  }
  if (/未遵守原生工具调用协议|未返回原生工具调用事件/i.test(source)) {
    return decision("protocol", "request", false, false, false, "所选模型未返回当前任务必需的原生工具调用")
  }
  if (/模型返回空响应|未产生正文或原生工具调用/i.test(source)) {
    return decision("protocol", "request", false, false, false, "所选模型未产生有效回复")
  }
  if (/(thinking mode.*tool_choice|reasoning_content|tool calls?|invalid_request_error|http\s*400)/i.test(source)) {
    const summary = /thinking mode.*tool_choice/i.test(source)
      ? "模型推理模式与工具调用协议不兼容"
      : /reasoning_content/i.test(source)
        ? "模型推理上下文协议不兼容"
        : "模型请求协议不兼容"
    return decision("protocol", "request", false, false, false, summary)
  }
  return decision("request", "request", false, false, false, "模型调用失败")
}

export function isQuotaError(error: string | undefined): boolean {
  return Boolean(error && /(accountquotaexceeded|insufficient[_ -]?quota|quota.{0,40}(?:exceed|exhaust|deplet|用尽|耗尽|不足)|exceed.{0,40}(?:usage|hour).{0,20}quota|token\s*plan.{0,40}(?:limit|usage|exceed)|配额.{0,20}(?:用尽|耗尽|不足|上限)|额度.{0,20}(?:用尽|耗尽|不足|上限)|用量.{0,12}(?:用尽|耗尽|不足|上限)|购买积分.{0,20}(?:补充|恢复)?用量)/i.test(error))
}

export function quotaResetAt(error: string | undefined): number | undefined {
  if (!error) return undefined
  const match = error.match(
    /reset\s+at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})/i,
  )
  if (!match) return undefined
  const timestamp = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function isStreamFailure(error: string): boolean {
  return /(响应流|流式|stream|sse).{0,40}(?:中断|断开|超时|失败|disconnect|timeout|failed)|responsestream/i.test(error)
}

function isTransientRequestFailure(error: string): boolean {
  return /(请求超时|timed?\s*out|timeout|fetch failed|failed to fetch|network|dns|econn|enotfound|socket|serveroverloaded|overloaded|rate.?limit|限流|service unavailable|bad gateway|无法连接模型服务|http\s*(?:408|425|429|5\d\d))/i.test(error)
}

function streamSummary(error: string): string {
  if (/(超时|timed?\s*out|timeout)/i.test(error)) return "模型响应流等待超时"
  return "模型响应流连接中断"
}

function requestSummary(error: string): string {
  if (/(请求超时|timed?\s*out|timeout)/i.test(error)) return "模型服务请求超时"
  if (/(429|serveroverloaded|overloaded|rate.?limit|限流)/i.test(error)) return "模型服务繁忙或受到限流"
  if (/(http\s*5\d\d|service unavailable|bad gateway)/i.test(error)) return "模型服务暂时不可用"
  return "无法连接模型服务"
}

function decision(
  kind: ModelFailureClass,
  persistenceKind: ModelFailureDecision["persistenceKind"],
  retryable: boolean,
  externalBlocker: boolean,
  faultDomainFailure: boolean,
  summary: string,
): ModelFailureDecision {
  return { kind, persistenceKind, retryable, externalBlocker, faultDomainFailure, summary }
}

function formatResetAt(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp))
}
