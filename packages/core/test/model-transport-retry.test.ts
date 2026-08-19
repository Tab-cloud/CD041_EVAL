import { afterAll, describe, expect, test } from "bun:test"
import type { ModelConfig } from "../src/model-router/types.ts"
import { LLMClient, type LLMEvent } from "../src/runtime/llm-client.ts"
import { nextModelTransportRetry } from "../src/runtime/model-transport-retry.ts"

let requestFailures = 0
let streamFailures = 0
let quotaRequests = 0

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path.includes("request-retry")) {
      requestFailures++
      if (requestFailures <= 2) {
        return Response.json({ error: { message: "Service Unavailable" } }, { status: 503 })
      }
      return successfulStream("request recovered")
    }
    if (path.includes("stream-retry")) {
      streamFailures++
      if (streamFailures <= 2) {
        return new Response(streamChunk(`discarded-${streamFailures}`, null), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return successfulStream("stream recovered")
    }
    quotaRequests++
    return Response.json({
      error: {
        message: "已达到 Token Plan 用量上限，请补充额度",
        type: "rate_limit_error",
      },
    }, { status: 429 })
  },
})

afterAll(() => server.stop(true))

describe("Codex-style model transport retry", () => {
  test("uses independent bounded budgets for request and stream reconnects", () => {
    const previousRequest = process.env.EVAL_MODEL_REQUEST_MAX_RETRIES
    const previousStream = process.env.EVAL_MODEL_STREAM_MAX_RETRIES
    delete process.env.EVAL_MODEL_REQUEST_MAX_RETRIES
    delete process.env.EVAL_MODEL_STREAM_MAX_RETRIES
    try {
      expect(nextModelTransportRetry("HTTP 503 Service Unavailable", 0, () => 0)).toMatchObject({
        attempt: 1,
        maxAttempts: 4,
        failureKind: "request",
      })
      expect(nextModelTransportRetry("HTTP 503 Service Unavailable", 4, () => 0)).toBeUndefined()
      expect(nextModelTransportRetry("模型响应流在完成前中断", 4, () => 0)).toMatchObject({
        attempt: 5,
        maxAttempts: 5,
        failureKind: "stream",
      })
      expect(nextModelTransportRetry("模型响应流在完成前中断", 5, () => 0)).toBeUndefined()
      expect(nextModelTransportRetry("HTTP 429: AccountQuotaExceeded", 0, () => 0)).toBeUndefined()
    } finally {
      restoreEnv("EVAL_MODEL_REQUEST_MAX_RETRIES", previousRequest)
      restoreEnv("EVAL_MODEL_STREAM_MAX_RETRIES", previousStream)
    }
  })

  test("retries the same selected model after transient request failures", async () => {
    requestFailures = 0
    const events = await collect(model("request-retry"))

    expect(requestFailures).toBe(3)
    expect(events.filter((event) => event.type === "transport-retry")).toHaveLength(2)
    expect(events.filter((event) => event.type === "transport-retry")
      .every((event: any) => event.failureKind === "request")).toBe(true)
    expect(text(events)).toBe("request recovered")
    expect(events.some((event) => event.type === "finish")).toBe(true)
    expect(events.some((event) => event.type === "error")).toBe(false)
  }, 10_000)

  test("discards partial stream drafts before reconnecting", async () => {
    streamFailures = 0
    const events = await collect(model("stream-retry"))

    expect(streamFailures).toBe(3)
    expect(events.filter((event) => event.type === "transport-retry")).toHaveLength(2)
    expect(events.filter((event) => event.type === "transport-retry")
      .every((event: any) => event.failureKind === "stream")).toBe(true)
    expect(text(events)).toBe("stream recovered")
    expect(text(events)).not.toContain("discarded")
    expect(events.some((event) => event.type === "finish")).toBe(true)
  }, 10_000)

  test("does not retry account quota exhaustion", async () => {
    quotaRequests = 0
    const events = await collect(model("quota"))
    expect(quotaRequests).toBe(1)
    expect(events.some((event) => event.type === "transport-retry")).toBe(false)
    expect(events.some((event) => event.type === "error"
      && event.message.includes("Token Plan"))).toBe(true)
  })
})

async function collect(config: ModelConfig): Promise<LLMEvent[]> {
  const events: LLMEvent[] = []
  for await (const event of new LLMClient().stream({
    model: config,
    system: "test",
    messages: [{ role: "user", content: "test" }],
  })) events.push(event)
  return events
}

function model(path: string): ModelConfig {
  return {
    id: path,
    name: path,
    provider: "openai-compatible",
    modelId: path,
    apiKey: "test",
    baseUrl: `http://127.0.0.1:${server.port}/${path}`,
    capabilities: ["chat"],
    priority: 1,
    costFactor: 1,
    enabled: true,
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
  }
}

function successfulStream(content: string): Response {
  return new Response(`${streamChunk(content, "stop")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function streamChunk(content: string, finishReason: string | null): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\n`
}

function text(events: LLMEvent[]): string {
  return events.filter((event) => event.type === "text-delta")
    .map((event: any) => event.text)
    .join("")
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
