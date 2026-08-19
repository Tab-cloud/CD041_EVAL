import { afterAll, describe, expect, test } from "bun:test"
import {
  describeLlmError, fallbackRequiredOutputLimit, LLMClient,
  projectOpenAIMessages, requiresReasoningReplay, type LLMEvent,
} from "../src/runtime/llm-client.ts"
import type { ModelConfig } from "../src/model-router/types.ts"

let lastRequestBody: Record<string, unknown> = {}
let requestBodies: Record<string, unknown>[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    lastRequestBody = await req.json() as Record<string, unknown>
    requestBodies.push(lastRequestBody)
    const pathname = new URL(req.url).pathname
    if (pathname.includes("reject-reasoning") && lastRequestBody.reasoning_split) {
      return Response.json({ error: { message: "unknown parameter reasoning_split" } }, { status: 400 })
    }
    if (pathname.includes("thinking-tool-conflict")
      && (lastRequestBody as any).thinking?.type !== "disabled") {
      return Response.json({
        error: {
          message: "Thinking mode does not support this tool_choice",
          type: "invalid_request_error",
        },
      }, { status: 400 })
    }
    if (pathname.includes("stream-error")) {
      return new Response(`data:${JSON.stringify({ error: { message: "message limit exceeded" } })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    }
    if (pathname.includes("message-payload")) {
      return new Response(`data:${JSON.stringify({
        choices: [{ message: { content: "compatible final message" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    }
    if (pathname.includes("reasoning")
      || pathname.includes("reject-reasoning")
      || pathname.includes("thinking-tool-conflict")) {
      const chunks = [
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "T" }] }, finish_reason: null }] },
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "Think" }] }, finish_reason: null }] },
        { choices: [{ delta: { content: "D" }, finish_reason: null }] },
        { choices: [{ delta: { content: "Done" }, finish_reason: null }] },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-read",
                function: { name: "read", arguments: "{\"path\":\"main.c\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    }
    const partial = {
      choices: [{ delta: { content: "partial" }, finish_reason: null }],
    }
    return new Response(`data: ${JSON.stringify(partial)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

afterAll(() => server.stop(true))

describe("LLM streaming completion", () => {
  test("missing credentials are a terminal error rather than successful model text", async () => {
    const model: ModelConfig = {
      id: "missing-key", name: "Missing Key", provider: "openai-compatible", modelId: "missing-key",
      apiKey: "", baseUrl: "https://example.com/v1", capabilities: ["vision"], priority: 1,
      costFactor: 1, enabled: true, contextWindow: 8_192, maxOutputTokens: 1_024,
    }
    const events: LLMEvent[] = []
    for await (const event of new LLMClient().stream({ model, system: "test", messages: [] })) events.push(event)

    expect(events).toEqual([{ type: "error", message: "未配置 API Key，请在模型设置中完成凭据配置" }])
    expect(events.some((event) => event.type === "finish")).toBe(false)
  })

  test("strict reasoning replay follows capabilities instead of vendor names", () => {
    const model: ModelConfig = {
      id: "reasoning-protocol-test", name: "Reasoning Protocol Test", provider: "openai-compatible", modelId: "reasoning-protocol-test",
      capabilities: ["reasoning", "coding"], priority: 1, costFactor: 1, enabled: true,
      contextWindow: 128_000, maxOutputTokens: 8_192,
    }
    expect(requiresReasoningReplay(model, true)).toBe(true)
    expect(requiresReasoningReplay(model, false)).toBe(false)
  })

  test("folds foreign tool transactions before replaying them to strict reasoning models", () => {
    const projected = projectOpenAIMessages("system", [
      { role: "assistant", content: "", originModelId: "minimax", toolCalls: [{ id: "call-1", name: "edit", input: { path: "main.c" } }] },
      { role: "tool", content: "", toolResults: [{ id: "call-1", name: "edit", result: { success: true } }] },
    ], { supportsVision: false, requireReasoningReplay: true, currentModelId: "deepseek" })
    expect(projected.some((message) => message.tool_calls || message.role === "tool")).toBe(false)
    expect(projected[1].content).toContain("历史执行证据")
    expect(projected[2].content).toContain("历史结果摘要")
    expect(projected[1].content).not.toContain('"calls"')
    expect(projected[1].content).not.toContain('"path":"main.c"')
    expect(projected[2].content).not.toContain('"results"')
  })

  test("replays native strict-reasoning tool transactions with exact reasoning content", () => {
    const projected = projectOpenAIMessages("system", [
      { role: "assistant", content: "", originModelId: "deepseek", reasoningContent: "verified reasoning", toolCalls: [{ id: "call-1", name: "read", input: { path: "main.c" } }] },
      { role: "tool", content: "", toolResults: [{ id: "call-1", name: "read", result: "ok" }] },
    ], { supportsVision: false, requireReasoningReplay: true, currentModelId: "deepseek" })
    expect(projected[1].reasoning_content).toBe("verified reasoning")
    expect(projected[1].tool_calls[0].function.name).toBe("read")
    expect(projected[2]).toMatchObject({ role: "tool", tool_call_id: "call-1" })
  })

  test("replays separated reasoning details for interleaved tool transactions", () => {
    const details = [{ type: "reasoning.text", text: "verified reasoning" }]
    const projected = projectOpenAIMessages("system", [
      {
        role: "assistant",
        content: "",
        originModelId: "reasoning-model",
        reasoningDetails: details,
        toolCalls: [{ id: "call-1", name: "read", input: { path: "main.c" } }],
      },
      { role: "tool", content: "", toolResults: [{ id: "call-1", name: "read", result: "ok" }] },
    ], { supportsVision: false, requireReasoningReplay: true, currentModelId: "reasoning-model" })
    expect(projected[1].reasoning_details).toEqual(details)
    expect(projected[1].tool_calls[0].function.name).toBe("read")
  })

  test("negotiates separated reasoning and parses cumulative compatible streams without duplication", async () => {
    requestBodies = []
    const model: ModelConfig = {
      id: "reasoning-stream", name: "Reasoning Stream", provider: "openai-compatible", modelId: "reasoning-stream",
      apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}/reasoning`,
      capabilities: ["reasoning", "coding"], priority: 50, costFactor: 1, enabled: true,
      contextWindow: 8_192, maxOutputTokens: 1_024,
    }
    const events: LLMEvent[] = []
    for await (const event of new LLMClient().stream({
      model,
      system: "test",
      messages: [],
      tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
      toolChoice: { name: "read" },
    })) events.push(event)

    expect(requestBodies[0]?.reasoning_split).toBe(true)
    expect(events.filter((event) => event.type === "thinking-delta").map((event: any) => event.text).join("")).toBe("Think")
    expect(events.filter((event) => event.type === "text-delta").map((event: any) => event.text).join("")).toBe("Done")
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({ name: "read", input: { path: "main.c" } })
    expect(events.find((event) => event.type === "finish")).toMatchObject({
      reasoningDetails: [{ type: "reasoning.text", text: "Think" }],
    })
  })

  test("falls back when an OpenAI-compatible endpoint rejects separated reasoning", async () => {
    requestBodies = []
    const model: ModelConfig = {
      id: "reasoning-negotiation", name: "Reasoning Negotiation", provider: "openai-compatible", modelId: "reasoning-negotiation",
      apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}/reject-reasoning`,
      capabilities: ["reasoning"], priority: 50, costFactor: 1, enabled: true,
      contextWindow: 8_192, maxOutputTokens: 1_024,
    }
    const events: LLMEvent[] = []
    for await (const event of new LLMClient().stream({ model, system: "test", messages: [] })) events.push(event)

    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[0]?.reasoning_split).toBe(true)
    expect(requestBodies[1]?.reasoning_split).toBeUndefined()
    expect(events.some((event) => event.type === "finish")).toBe(true)
  })

  test("negotiates a thinking and tool_choice protocol conflict without changing models", async () => {
    requestBodies = []
    const model: ModelConfig = {
      id: "thinking-tool-conflict",
      name: "Thinking Tool Conflict",
      provider: "openai-compatible",
      modelId: "opaque-user-configured-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/thinking-tool-conflict`,
      capabilities: ["reasoning", "coding"],
      priority: 50,
      costFactor: 1,
      enabled: true,
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
    }
    const events: LLMEvent[] = []
    for await (const event of new LLMClient().stream({
      model,
      system: "test",
      messages: [],
      tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
      toolChoice: "required",
      thinkingEnabled: true,
    })) events.push(event)

    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[0]?.tool_choice).toBe("required")
    expect(requestBodies[0]?.reasoning_split).toBe(true)
    expect((requestBodies[1] as any)?.thinking).toEqual({ type: "disabled" })
    expect(requestBodies[1]?.reasoning_split).toBeUndefined()
    expect(requestBodies[1]?.tool_choice).toBe("required")
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({
      name: "read",
      input: { path: "main.c" },
    })
    expect(events.some((event) => event.type === "finish")).toBe(true)
  })

  test("reports an interrupted OpenAI stream without emitting finish", async () => {
    const model: ModelConfig = {
      id: "test", name: "Test", provider: "openai-compatible", modelId: "test-model",
      apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}`,
      capabilities: ["chat"], priority: 50, costFactor: 1, enabled: true,
      contextWindow: 8_192, maxOutputTokens: 1_024,
    }
    const events: LLMEvent[] = []
    const controller = new AbortController()
    for await (const event of new LLMClient().stream({ model, system: "test", messages: [], maxOutputTokens: 512, thinkingEnabled: false, signal: controller.signal })) {
      events.push(event)
      if (event.type === "transport-retry") controller.abort()
    }

    expect(events.some((event) => event.type === "text-delta")).toBe(false)
    expect(events.some((event) => event.type === "transport-retry")).toBe(true)
    expect(events.some((event) => event.type === "error" && event.message.includes("取消"))).toBe(true)
    expect(events.some((event) => event.type === "finish")).toBe(false)
    expect(lastRequestBody.max_tokens).toBe(512)
    expect(lastRequestBody.thinking).toEqual({ type: "disabled" })
    expect(lastRequestBody.extra_body).toBeUndefined()
  })

  test("surfaces provider errors carried inside a successful SSE response", async () => {
    const model: ModelConfig = {
      id: "stream-error", name: "Stream Error", provider: "openai-compatible", modelId: "stream-error",
      apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}/stream-error`,
      capabilities: ["chat"], priority: 50, costFactor: 1, enabled: true,
      contextWindow: 8_192, maxOutputTokens: 1_024,
    }
    const events: LLMEvent[] = []
    for await (const event of new LLMClient().stream({ model, system: "test", messages: [] })) events.push(event)
    expect(events.some((event) => event.type === "error" && event.message.includes("message limit exceeded"))).toBe(true)
    expect(events.some((event) => event.type === "finish")).toBe(false)
  })

  test("accepts compatible gateways that emit a final message instead of deltas", async () => {
    const model: ModelConfig = {
      id: "message-payload", name: "Message Payload", provider: "openai-compatible", modelId: "message-payload",
      apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}/message-payload`,
      capabilities: ["chat"], priority: 50, costFactor: 1, enabled: true,
      contextWindow: 8_192, maxOutputTokens: 1_024,
    }
    const events: LLMEvent[] = []
    for await (const event of new LLMClient().stream({ model, system: "test", messages: [] })) events.push(event)
    expect(events.filter((event) => event.type === "text-delta").map((event: any) => event.text).join("")).toBe("compatible final message")
    expect(events.some((event) => event.type === "finish")).toBe(true)
  })

  test("uses the configured model output limit when no workload override is supplied", async () => {
    const model: ModelConfig = {
      id: "large-output", name: "Large Output", provider: "openai-compatible", modelId: "large-output-model",
      apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}`,
      capabilities: ["vision"], priority: 50, costFactor: 1, enabled: true,
      contextWindow: 2_000_000, maxOutputTokens: 1_000_000,
    }
    const controller = new AbortController()

    for await (const event of new LLMClient().stream({
      model, system: "test", messages: [], signal: controller.signal,
    })) {
      // Wait until the test server has received the request body.
      if (event.type === "transport-retry") controller.abort()
    }

    expect(lastRequestBody.max_tokens).toBe(1_000_000)
  })

  test("required output limits adapt to provider feedback without model ID rules", () => {
    expect(fallbackRequiredOutputLimit(1_000_000, "max_tokens must be less than or equal to 65536")).toBe(65_536)
    expect(fallbackRequiredOutputLimit(1_000_000, "invalid generation limit")).toBe(32_768)
  })

  test("turns transport failures into actionable endpoint errors", () => {
    const message = describeLlmError(new TypeError("network error"), "https://api.example.com/v1")
    expect(message).toContain("无法连接模型服务 api.example.com")
    expect(message).toContain("Base URL")
  })

  test("reserves output space and iteratively trims old OpenAI messages", async () => {
    const model: ModelConfig = {
      id: "small", name: "Small", provider: "openai-compatible", modelId: "small-model",
      apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}`,
      capabilities: ["chat"], priority: 50, costFactor: 1, enabled: true,
      contextWindow: 4_096, maxOutputTokens: 1_024,
    }
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `${index}:${"x".repeat(1_000)}`,
    }))
    const controller = new AbortController()
    for await (const event of new LLMClient().stream({
      model, system: "system", messages, signal: controller.signal,
    })) {
      // 只需等待请求被测试服务器接收。
      if (event.type === "transport-retry") controller.abort()
    }
    const sent = lastRequestBody.messages as Array<{ role: string; content: string }>
    expect(sent.length).toBeLessThan(messages.length + 1)
    expect(sent[0].role).toBe("system")
    expect(sent.at(-1)?.content).toBe(messages.at(-1)?.content)
  })
})
