import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { ModelConfig } from "../src/model-router/types.ts"
import {
  isFaultDomainFailure,
  isModelExternalBlocker,
  isQuotaExhaustedFailure,
  LLMManager,
  modelCircuitKey,
  modelFaultDomain,
  prioritizeFallbackDomains,
  quotaResetAt,
  summarizeModelFailure,
} from "../src/runtime/llm-manager.ts"

describe("LLM fallback fault domains", () => {
  test("prioritizes different API hosts before another model on the failed endpoint", () => {
    const primary = model("mimo", "https://api.minimaxi.com/v1")
    const sameEndpoint = model("minimax", "https://api.minimaxi.com/v1/chat")
    const deepseek = model("deepseek", "https://api.deepseek.com/v1")
    const qwen = model("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1")

    expect(new LLMManager().buildFallbackChain(primary, [primary, sameEndpoint, deepseek, qwen]).map((item) => item.id))
      .toEqual(["mimo", "deepseek", "qwen", "minimax"])
    expect(prioritizeFallbackDomains(primary, [sameEndpoint, deepseek]).map((item) => item.id))
      .toEqual(["mimo", "deepseek", "minimax"])
  })

  test("uses the API host rather than the compatible protocol label as the fault domain", () => {
    expect(modelFaultDomain(model("a", "https://api.minimaxi.com/v1")))
      .toBe(modelFaultDomain(model("b", "https://api.minimaxi.com/compatible-mode/v1")))
    expect(modelFaultDomain(model("a", "https://api.minimaxi.com/v1")))
      .not.toBe(modelFaultDomain(model("b", "https://api.deepseek.com/v1")))
  })

  test("skips endpoint siblings only for transport and service failures", () => {
    expect(isFaultDomainFailure("模型服务 api.minimaxi.com 请求超时，请检查网络或稍后重试")).toBe(true)
    expect(isFaultDomainFailure("HTTP 503 Service Unavailable")).toBe(true)
    expect(isFaultDomainFailure('HTTP 429: {"error":{"code":"ServerOverloaded"}}')).toBe(true)
    expect(isFaultDomainFailure("HTTP 401: invalid api key")).toBe(false)
  })

  test("treats exhausted transient failures as recoverable external blockers", () => {
    expect(isModelExternalBlocker("HTTP 503 Service Unavailable")).toBe(true)
    expect(isModelExternalBlocker("模型服务 token-plan-cn.xiaomimimo.com 请求超时")).toBe(true)
    expect(isModelExternalBlocker("模型响应流在完成前中断")).toBe(true)
    expect(isModelExternalBlocker("HTTP 400: invalid_request_error")).toBe(false)
  })

  test("opens a persistent endpoint circuit after a real failed attempt and closes it after cooldown", () => {
    const manager = new LLMManager()
    const unique = `https://fault-${randomUUID()}.example.test/v1`
    const primary = model("primary", unique)
    const attempt = manager.startModelAttempt({
      runId: "run-circuit",
      sessionId: "session-circuit",
      agentId: "main-agent",
      scope: "agent",
      operation: "root",
      segment: 0,
      step: 0,
      attempt: 1,
    }, primary)
    const completed = manager.finishModelAttempt(attempt.id, "failed", "HTTP 503 Service Unavailable")
    const failedAt = completed?.completedAt ?? Date.now()

    expect(manager.getModelAvailability(primary, failedAt + 1)).toMatchObject({
      available: false,
      consecutiveFailures: 1,
    })
    expect(manager.getModelAvailability(primary, failedAt + 60_001).available).toBe(true)
  })

  test("classifies exhausted account quota separately and honors the provider reset boundary", () => {
    const manager = new LLMManager()
    const unique = `https://quota-${randomUUID()}.example.test/v1`
    const primary = model("quota-primary", unique)
    const resetText = "2026-07-24 13:35:11 +0800 CST"
    const error = `HTTP 429: {"error":{"code":"AccountQuotaExceeded","message":"You have exceeded the 5-hour usage quota. It will reset at ${resetText}."}}`
    const resetAt = Date.parse("2026-07-24T13:35:11+08:00")
    const attempt = manager.startModelAttempt({
      runId: "run-quota",
      sessionId: "session-quota",
      agentId: "main-agent",
      scope: "agent",
      operation: "root",
      segment: 0,
      step: 0,
      attempt: 1,
    }, primary)
    const completed = manager.finishModelAttempt(attempt.id, "failed", error)

    expect(completed?.failureKind).toBe("quota")
    expect(isQuotaExhaustedFailure(error)).toBe(true)
    expect(quotaResetAt(error)).toBe(resetAt)
    expect(manager.getModelAvailability(primary, resetAt - 60_000)).toMatchObject({
      available: false,
      retryAt: resetAt,
      consecutiveFailures: 0,
    })
    expect(manager.getModelAvailability(primary, resetAt + 1).available).toBe(true)
    expect(summarizeModelFailure(error)).toContain("模型配额已耗尽")
    expect(summarizeModelFailure(error)).toContain("2026")
  })

  test("does not carry a quota circuit across account configuration revisions", () => {
    const manager = new LLMManager()
    const baseUrl = `https://quota-revision-${randomUUID()}.example.test/v1`
    const first = { ...model("shared-config", baseUrl), apiKey: "account-a" }
    const second = { ...model("shared-config", baseUrl), apiKey: "account-b" }
    expect(modelCircuitKey(first)).not.toBe(modelCircuitKey(second))

    const attempt = manager.startModelAttempt({
      runId: "run-account-revision",
      sessionId: "session-account-revision",
      agentId: "main-agent",
      scope: "agent",
      operation: "root",
      segment: 0,
      step: 0,
      attempt: 1,
    }, first)
    manager.finishModelAttempt(attempt.id, "failed", "AccountQuotaExceeded: quota exhausted")

    expect(manager.getModelAvailability(first).available).toBe(false)
    expect(manager.getModelAvailability(second).available).toBe(true)
  })

  test("recognizes the MiniMax Token Plan limit as an external quota blocker", () => {
    const error = "HTTP 429: 已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"
    expect(isQuotaExhaustedFailure(error)).toBe(true)
    expect(isModelExternalBlocker(error)).toBe(true)
    expect(summarizeModelFailure(error)).toBe("模型配额已耗尽，需等待额度恢复")

    const manager = new LLMManager()
    const configured = model("minimax-token-plan", `https://quota-${randomUUID()}.example.test/v1`)
    const attempt = manager.startModelAttempt({
      runId: "run-minimax-quota",
      sessionId: "session-minimax-quota",
      agentId: "main-agent",
      scope: "agent",
      operation: "root",
      segment: 1,
      step: 1,
      attempt: 1,
    }, configured)
    const completed = manager.finishModelAttempt(attempt.id, "failed", error)
    expect(completed?.failureKind).toBe("quota")
    expect(manager.getModelAvailability(configured).available).toBe(false)
  })

  test("correlates agent and tool attempts without exposing provider payloads", () => {
    const manager = new LLMManager()
    const runId = `run-${randomUUID()}`
    const configured = model("configured-key", `https://attempt-${randomUUID()}.example.test/v1`)
    const agentAttempt = manager.startModelAttempt({
      runId,
      sessionId: "session-attempt",
      agentId: "main-agent",
      scope: "agent",
      operation: "root",
      segment: 2,
      step: 3,
      attempt: 1,
    }, configured)
    manager.finishModelAttempt(agentAttempt.id, "succeeded")
    const toolAttempt = manager.startModelAttempt({
      runId,
      sessionId: "session-attempt",
      agentId: "main-agent",
      scope: "tool",
      operation: "schematic_read",
      segment: 2,
      step: 3,
      attempt: 1,
    }, configured)
    manager.finishModelAttempt(toolAttempt.id, "failed", "HTTP 429: private provider payload")

    expect(manager.getModelAttempts(runId).map((attempt) => [attempt.scope, attempt.operation, attempt.segment, attempt.step]))
      .toEqual([
        ["agent", "root", 2, 3],
        ["tool", "schematic_read", 2, 3],
      ])
    expect(summarizeModelFailure("HTTP 429: private provider payload")).toBe("模型服务繁忙或受到限流")
    expect(summarizeModelFailure(
      'HTTP 400: {"error":{"message":"Thinking mode does not support this tool_choice","type":"invalid_request_error"}}',
    )).toBe("模型推理模式与工具调用协议不兼容")
    expect(summarizeModelFailure("HTTP 400: invalid_request_error")).toBe("模型请求协议不兼容")
    expect(summarizeModelFailure("无法连接模型服务 api.deepseek.com")).toBe("无法连接模型服务")
    expect(summarizeModelFailure("TypeError: fetch failed, cause: ENOTFOUND")).toBe("无法连接模型服务")
  })
})

function model(id: string, baseUrl: string): ModelConfig {
  return {
    id,
    name: id,
    provider: "openai-compatible",
    modelId: id,
    baseUrl,
    capabilities: ["chat", "coding", "reasoning"],
    priority: 50,
    costFactor: 1,
    enabled: true,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  }
}
