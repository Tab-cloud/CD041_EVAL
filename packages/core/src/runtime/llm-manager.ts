/**
 * LLM Manager — Token 统计 + 调用日志 + 降级 Fallback
 */

import type { ModelConfig } from "../model-router/types.js"
import { CallLogRepo } from "../store/call-log"
import {
  ModelAttemptRepo,
  type ModelAttemptScope,
  type ModelAttemptStatus,
  type ModelAttemptView,
  type ModelFailureKind,
} from "../store/model-attempt.ts"
import { createHash, randomUUID } from "node:crypto"
import {
  classifyModelFailure,
  isQuotaError,
  quotaResetAt as classifiedQuotaResetAt,
} from "./model-failure-policy.ts"
import { logOrchestrationEvent } from "./orchestration-log.ts"

// ══════════════════════════════════════════════
// 类型
// ══════════════════════════════════════════════

export interface TokenUsage {
  modelId: string
  modelName: string
  promptTokens: number
  completionTokens: number
  timestamp: number
}

export interface CallLog {
  id: string
  modelId: string
  modelName: string
  agentId: string
  sessionId: string
  /** 用户消息摘要 */
  prompt: string
  /** 响应摘要 */
  response: string
  tokens: { prompt: number; completion: number }
  /** 延迟 (ms) */
  latency: number
  success: boolean
  error?: string
  routeReason?: string
  routeAttempts?: Array<{
    modelId: string
    modelName: string
    attempt: number
    fallback: boolean
    reason: string
    previousError?: string
    attemptId?: string
    scope?: ModelAttemptScope
    segment?: number
    step?: number
  }>
  timestamp: number
}

export interface UsageStats {
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCost: number
  byModel: Record<string, { calls: number; tokens: number; cost: number }>
  byAgent: Record<string, { calls: number; tokens: number }>
}

export interface ModelAttemptContext {
  runId: string
  sessionId: string
  agentId: string
  scope: ModelAttemptScope
  operation: string
  segment: number
  step: number
  attempt: number
}

export interface ModelAvailability {
  available: boolean
  consecutiveFailures: number
  retryAt?: number
  reason?: string
}

// ══════════════════════════════════════════════
// LLM Manager
// ══════════════════════════════════════════════

export class LLMManager {
  private callLogs: CallLog[] = []
  private tokenUsages: TokenUsage[] = []
  private maxLogs: number

  constructor(maxLogs = 500) {
    this.maxLogs = maxLogs
  }

  /** 记录一次 LLM 调用 */
  logCall(log: Omit<CallLog, "id">): CallLog {
    const entry: CallLog = { id: `call-${randomUUID()}`, ...log }
    this.callLogs.unshift(entry)
    if (this.callLogs.length > this.maxLogs) this.callLogs = this.callLogs.slice(0, this.maxLogs)
    CallLogRepo.insert(entry)
    return entry
  }

  /** 记录 Token 用量 */
  trackTokens(usage: Omit<TokenUsage, "timestamp">): void {
    this.tokenUsages.push({ ...usage, timestamp: Date.now() })
    if (this.tokenUsages.length > this.maxLogs) this.tokenUsages = this.tokenUsages.slice(-this.maxLogs)
  }

  /** 获取调用日志 */
  getCallLogs(filter?: { agentId?: string; modelId?: string; limit?: number }): CallLog[] {
    return CallLogRepo.list(filter)
  }

  /** 获取用量统计 */
  getUsageStats(): UsageStats {
    const stats: UsageStats = {
      totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalCost: 0,
      byModel: {}, byAgent: {},
    }

    for (const log of this.getCallLogs({ limit: 1_000 })) {
      if (!log.success) continue
      stats.totalCalls++
      stats.totalPromptTokens += log.tokens.prompt
      stats.totalCompletionTokens += log.tokens.completion

      // 按模型
      const mkey = log.modelId
      if (!stats.byModel[mkey]) stats.byModel[mkey] = { calls: 0, tokens: 0, cost: 0 }
      stats.byModel[mkey].calls++
      stats.byModel[mkey].tokens += log.tokens.prompt + log.tokens.completion

      // 按 Agent
      const akey = log.agentId
      if (!stats.byAgent[akey]) stats.byAgent[akey] = { calls: 0, tokens: 0 }
      stats.byAgent[akey].calls++
      stats.byAgent[akey].tokens += log.tokens.prompt + log.tokens.completion
    }

    // 估算成本 (基于常见价格)
    stats.totalCost = this.estimateCost()
    return stats
  }

  /** 获取 Token 用量时间线 */
  getTokenTimeline(hours = 24): Array<{ time: string; tokens: number }> {
    const cutoff = Date.now() - hours * 3600_000
    const recent = this.getCallLogs({ limit: 1_000 }).filter((log) => log.timestamp > cutoff)
    const buckets = new Map<string, number>()

    for (const log of recent) {
      const key = new Date(log.timestamp).toISOString().slice(0, 13) + ":00"
      buckets.set(key, (buckets.get(key) ?? 0) + log.tokens.prompt + log.tokens.completion)
    }

    return Array.from(buckets.entries()).map(([time, tokens]) => ({ time, tokens })).sort((a, b) => a.time.localeCompare(b.time))
  }

  /** 获取失败率 */
  getErrorRate(hours = 24): { total: number; errors: number; rate: number } {
    const cutoff = Date.now() - hours * 3600_000
    const recent = this.getCallLogs({ limit: 1_000 }).filter((l) => l.timestamp > cutoff)
    const errors = recent.filter((l) => !l.success).length
    return { total: recent.length, errors, rate: recent.length > 0 ? errors / recent.length : 0 }
  }

  /** 清空日志 */
  clearLogs(): void {
    this.callLogs = []
    this.tokenUsages = []
    CallLogRepo.clear()
  }

  /** 导出日志为 JSON */
  exportLogs(): string {
    return JSON.stringify({ callLogs: this.getCallLogs({ limit: 1_000 }), exportedAt: new Date().toISOString() }, null, 2)
  }

  // ─── Fallback 降级逻辑 ───

  /**
   * 给定主模型，返回 fallback 链 [primary, backup1, backup2, ..., mock]
   */
  buildFallbackChain(
    primary: ModelConfig,
    allModels: ModelConfig[],
  ): ModelConfig[] {
    return prioritizeFallbackDomains(primary, allModels.filter(
      (model) => model.enabled && !sameModel(model, primary),
    ))
  }

  startModelAttempt(context: ModelAttemptContext, model: ModelConfig): ModelAttemptView {
    const attempt = ModelAttemptRepo.start({
      id: `model-attempt-${randomUUID()}`,
      ...context,
      modelKey: modelCircuitKey(model),
      modelId: concreteModelId(model),
      modelName: model.name,
      faultDomain: modelFaultDomain(model),
    })
    logModelAttempt(attempt)
    return attempt
  }

  finishModelAttempt(
    id: string,
    status: Extract<ModelAttemptStatus, "succeeded" | "failed" | "cancelled">,
    error?: string,
  ): ModelAttemptView | null {
    const failureKind: ModelFailureKind | undefined = status === "succeeded"
      ? undefined
      : status === "cancelled"
        ? "cancelled"
        : classifyModelFailure(error).persistenceKind
    const attempt = ModelAttemptRepo.finish(id, status, failureKind, error)
    if (attempt) logModelAttempt(attempt)
    return attempt
  }

  recordCircuitSkip(context: ModelAttemptContext, model: ModelConfig, reason: string): ModelAttemptView {
    const attempt = ModelAttemptRepo.recordSkipped({
      id: `model-attempt-${randomUUID()}`,
      ...context,
      modelKey: modelCircuitKey(model),
      modelId: concreteModelId(model),
      modelName: model.name,
      faultDomain: modelFaultDomain(model),
      error: reason,
    })
    logModelAttempt(attempt)
    return attempt
  }

  /**
   * Endpoint health is derived from every real attempt, not the final result of
   * an entire Agent run. One transport/service failure opens a short circuit;
   * repeated failures extend it exponentially. Request errors never poison
   * sibling models on the same endpoint.
   */
  getModelAvailability(model: ModelConfig, now = Date.now()): ModelAvailability {
    const faultDomain = modelFaultDomain(model)
    const modelRecent = ModelAttemptRepo.recentByModel(modelCircuitKey(model), now - 24 * 60 * 60_000, 200)
    // Quota exhaustion is neither server load nor an exponentially retried
    // network fault. Respect the provider's reset boundary and avoid probing
    // the same account every minute. A later success supersedes older quota
    // records.
    for (const attempt of modelRecent) {
      if (attempt.status === "succeeded") break
      if (!isQuotaExhaustedFailure(attempt.error)) continue
      const parsedReset = quotaResetAt(attempt.error)
      // A provider reset in the past means the circuit has expired. Do not
      // invent another 15-minute penalty after the declared boundary.
      if (parsedReset && parsedReset <= now) break
      const retryAt = parsedReset ?? (attempt.completedAt ?? now) + 15 * 60_000
      if (now >= retryAt) break
      return {
        available: false,
        consecutiveFailures: 0,
        retryAt,
        reason: `${summarizeModelFailure(attempt.error)}，约 ${Math.max(1, Math.ceil((retryAt - now) / 60_000))} 分钟后重试`,
      }
    }
    const recent = ModelAttemptRepo.recentByFaultDomain(faultDomain, now - 10 * 60_000)
    let consecutiveFailures = 0
    for (const attempt of recent) {
      if (attempt.status === "succeeded") break
      if (attempt.status !== "failed" || attempt.failureKind !== "fault-domain") break
      consecutiveFailures++
    }
    if (consecutiveFailures === 0) return { available: true, consecutiveFailures: 0 }
    const latestFailure = recent[0]
    const cooldownMs = Math.min(5 * 60_000, 60_000 * 2 ** (consecutiveFailures - 1))
    const retryAt = (latestFailure?.completedAt ?? now) + cooldownMs
    if (now >= retryAt) return { available: true, consecutiveFailures, retryAt }
    const seconds = Math.max(1, Math.ceil((retryAt - now) / 1_000))
    return {
      available: false,
      consecutiveFailures,
      retryAt,
      reason: `${faultDomain} 暂时熔断：最近 ${consecutiveFailures} 次服务或网络失败，约 ${seconds} 秒后重试`,
    }
  }

  getModelAttempts(runId: string, limit = 200): ModelAttemptView[] {
    return ModelAttemptRepo.listByRun(runId, limit)
  }

  // ─── 内部 ───

  private estimateCost(): number {
    // Provider prices are external configuration, never inferred from modelId.
    // Until per-model billing metadata is configured, expose a stable generic
    // estimate rather than silently applying a stale vendor price table.
    const baseline = { prompt: 1, completion: 5 }
    let cost = 0
    for (const log of this.getCallLogs({ limit: 1_000 })) {
      if (!log.success) continue
      cost += (log.tokens.prompt / 1_000_000) * baseline.prompt
      cost += (log.tokens.completion / 1_000_000) * baseline.completion
    }
    return Math.round(cost * 10000) / 10000
  }
}

export const llmManager = new LLMManager()

/**
 * API 主机才是网络故障域；`openai-compatible` 只是协议类型，不能用于容灾分组。
 * 路径不同但主机相同的模型仍共享 DNS、连接和网关故障。
 */
export function modelFaultDomain(model: ModelConfig): string {
  const baseUrl = model.baseUrl?.trim() || defaultBaseUrl(model.provider)
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return `${model.provider.toLowerCase()}:${baseUrl.toLowerCase()}`
  }
}

/**
 * Quota state belongs to one configured account endpoint, not to a display
 * model ID. Hashing the identity prevents credentials from entering logs while
 * ensuring an edited account does not inherit the previous account's circuit.
 */
export function modelCircuitKey(model: ModelConfig): string {
  const identity = [
    model.id,
    model.provider.trim().toLowerCase(),
    (model.baseUrl?.trim() || defaultBaseUrl(model.provider)).replace(/\/+$/, "").toLowerCase(),
    concreteModelId(model),
    model.apiKey ?? "",
  ].join("\u0000")
  const revision = createHash("sha256").update(identity).digest("hex").slice(0, 20)
  return `${model.id}:${revision}`
}

/**
 * 先在每个独立故障域尝试一个模型，再尝试同域的其余模型。
 * 这样三次调用预算不会被同一失效网关耗尽。
 */
export function prioritizeFallbackDomains(primary: ModelConfig, fallbacks: ModelConfig[]): ModelConfig[] {
  const unique = fallbacks.filter((model, index, values) =>
    !sameModel(model, primary) && values.findIndex((candidate) => sameModel(candidate, model)) === index)
  const primaryDomain = modelFaultDomain(primary)
  const domains = new Map<string, ModelConfig[]>()
  for (const model of unique) {
    const domain = modelFaultDomain(model)
    const bucket = domains.get(domain) ?? []
    bucket.push(model)
    domains.set(domain, bucket)
  }

  const chain = [primary]
  for (const [domain, models] of domains) {
    if (domain !== primaryDomain && models[0]) chain.push(models[0])
  }
  for (const [domain, models] of domains) {
    if (domain !== primaryDomain) chain.push(...models.slice(1))
  }
  chain.push(...(domains.get(primaryDomain) ?? []))
  return chain
}

/** Only transport/service failures imply that sibling models on the same endpoint should be skipped. */
export function isFaultDomainFailure(error: string | undefined): boolean {
  return classifyModelFailure(error).faultDomainFailure
}

export function isQuotaExhaustedFailure(error: string | undefined): boolean {
  return isQuotaError(error)
}

/** Failures that require an account/model choice or provider recovery rather than another Agent action. */
export function isModelExternalBlocker(error: string | undefined): boolean {
  return classifyModelFailure(error).externalBlocker
}

/** Extract a provider-declared quota reset time without depending on model IDs. */
export function quotaResetAt(error: string | undefined): number | undefined {
  return classifiedQuotaResetAt(error)
}

/** User-facing reason without provider payloads, internal IDs, or stack traces. */
export function summarizeModelFailure(error: string | undefined): string | undefined {
  return error ? classifyModelFailure(error).summary : undefined
}

function logModelAttempt(attempt: ModelAttemptView): void {
  logOrchestrationEvent({
    sessionId: attempt.sessionId,
    runId: attempt.runId,
    agentId: attempt.agentId,
    eventType: `model-attempt.${attempt.status}`,
    level: attempt.status === "failed"
      ? "error"
      : attempt.status === "skipped" || attempt.status === "cancelled"
        ? "warning"
        : "info",
    message: attempt.status === "running"
      ? "模型调用已开始"
      : attempt.status === "succeeded"
        ? "模型调用已完成"
        : attempt.status === "skipped"
          ? "模型调用因熔断或配额状态被跳过"
          : attempt.status === "cancelled"
            ? "模型调用已取消"
            : "模型调用失败",
    data: {
      attemptId: attempt.id,
      scope: attempt.scope,
      operation: attempt.operation,
      segment: attempt.segment,
      step: attempt.step,
      attempt: attempt.attempt,
      modelId: attempt.modelId,
      modelName: attempt.modelName,
      faultDomain: attempt.faultDomain,
      status: attempt.status,
      failureKind: attempt.failureKind,
      latency: attempt.latency,
      error: attempt.error,
    },
  })
}

function sameModel(left: ModelConfig, right: ModelConfig): boolean {
  return left.id === right.id && left.modelId === right.modelId
}

function concreteModelId(model: ModelConfig): string {
  return model.modelId.split(",")[0]?.trim() || model.modelId
}

function defaultBaseUrl(provider: string): string {
  if (provider === "anthropic") return "https://api.anthropic.com"
  return "https://api.openai.com"
}
