import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { TokenUsageRepo } from "../src/store/token-usage.ts"
import { LLMClient } from "../src/runtime/llm-client.ts"
import type { ModelConfig } from "../src/model-router/types.ts"

describe("durable token usage ledger", () => {
  test("deduplicates billing events and maintains session daily rollups", () => {
    const sessionId = `token-session-${randomUUID()}`
    const runId = `token-run-${randomUUID()}`
    const actualId = `usage-${randomUUID()}`
    const estimatedId = `usage-${randomUUID()}`

    expect(TokenUsageRepo.record({
      id: actualId,
      attemptId: `attempt-${randomUUID()}`,
      runId,
      sessionId,
      agentId: "main-agent",
      scope: "agent",
      operation: "root",
      segment: 0,
      step: 0,
      providerId: "openai-compatible",
      modelId: "model-a",
      modelName: "Model A",
      promptTokens: 1_000,
      completionTokens: 250,
      cacheReadInputTokens: 400,
      source: "actual",
      localDay: "2030-01-15",
    })).toBe(true)
    expect(TokenUsageRepo.record({
      id: actualId,
      attemptId: "duplicate",
      runId,
      sessionId,
      agentId: "main-agent",
      scope: "agent",
      operation: "root",
      segment: 0,
      step: 0,
      providerId: "openai-compatible",
      modelId: "model-a",
      modelName: "Model A",
      promptTokens: 99_999,
      completionTokens: 99_999,
      source: "estimated",
      localDay: "2030-01-15",
    })).toBe(false)
    expect(TokenUsageRepo.record({
      id: estimatedId,
      attemptId: `attempt-${randomUUID()}`,
      runId,
      sessionId,
      agentId: "schematic-reader",
      scope: "tool",
      operation: "vision",
      segment: 1,
      step: 2,
      providerId: "anthropic",
      modelId: "model-b",
      modelName: "Model B",
      promptTokens: 700,
      completionTokens: 100,
      source: "estimated",
      localDay: "2030-01-14",
    })).toBe(true)

    const heatmap = TokenUsageRepo.heatmap({
      days: 7,
      scope: "session",
      sessionId,
      now: new Date(2030, 0, 15, 12).getTime(),
    })
    expect(heatmap.startDate).toBe("2030-01-09")
    expect(heatmap.endDate).toBe("2030-01-15")
    expect(heatmap.days).toHaveLength(7)
    expect(heatmap.days.at(-2)).toMatchObject({
      date: "2030-01-14",
      promptTokens: 700,
      completionTokens: 100,
      totalTokens: 800,
      calls: 1,
      actualCalls: 0,
      estimatedCalls: 1,
    })
    expect(heatmap.days.at(-1)).toMatchObject({
      date: "2030-01-15",
      promptTokens: 1_000,
      completionTokens: 250,
      cacheReadInputTokens: 400,
      totalTokens: 1_250,
      calls: 1,
      actualCalls: 1,
      estimatedCalls: 0,
    })
    expect(heatmap.totals).toMatchObject({
      promptTokens: 1_700,
      completionTokens: 350,
      totalTokens: 2_050,
      calls: 2,
      actualCalls: 1,
      estimatedCalls: 1,
    })
  })

  test("rejects session heatmaps without a session identity", () => {
    expect(() => TokenUsageRepo.heatmap({ scope: "session" })).toThrow(
      "必须提供 sessionId",
    )
  })

  test("LLM transport records provider-reported usage exactly once", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const chunks = [
          {
            choices: [{ delta: { content: "done" }, finish_reason: null }],
          },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 321, completion_tokens: 45 },
          },
        ]
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
            + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      const sessionId = `transport-session-${randomUUID()}`
      const attemptId = `transport-attempt-${randomUUID()}`
      const model: ModelConfig = {
        id: "usage-test",
        name: "Usage Test",
        provider: "openai-compatible",
        modelId: "usage-test",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${server.port}`,
        capabilities: ["chat"],
        priority: 1,
        costFactor: 1,
        enabled: true,
        contextWindow: 8_192,
        maxOutputTokens: 1_024,
      }
      const request = {
        model,
        system: "test",
        messages: [{ role: "user", content: "hello" }],
        usageContext: {
          eventId: `usage:${attemptId}:0`,
          attemptId,
          runId: `run-${randomUUID()}`,
          sessionId,
          agentId: "main-agent",
          scope: "agent" as const,
          operation: "root",
          segment: 0,
          step: 0,
        },
      }
      for await (const _event of new LLMClient().stream(request)) { /* consume */ }
      for await (const _event of new LLMClient().stream(request)) { /* replay */ }

      const heatmap = TokenUsageRepo.heatmap({
        days: 7,
        scope: "session",
        sessionId,
      })
      expect(heatmap.totals).toMatchObject({
        promptTokens: 321,
        completionTokens: 45,
        totalTokens: 366,
        calls: 1,
        actualCalls: 1,
        estimatedCalls: 0,
      })
    } finally {
      server.stop(true)
    }
  })
})
