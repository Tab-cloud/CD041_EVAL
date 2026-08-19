/**
 * server-test-connection.ts — 测试连接处理器
 */
import type { ModelConfig, ModelVariantConfig } from "../model-router/types"
import { llmClient } from "./llm-client"
import { configStore } from "./config-store"
import type { ModelRouter } from "../model-router/index"
import {
  observeNativeToolProtocolFailure,
  observeNativeToolProtocolSuccess,
} from "./model-protocol-observation.ts"
import { ModelProtocolCapabilityRepo } from "../store/model-protocol-capability.ts"

function json(data: unknown, extraHeaders?: Record<string, unknown>): Response {
  const h: Record<string, string> = { "Content-Type": "application/json" }
  let status = 200
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (k === "status" && typeof v === "number") status = v
      else if (typeof v === "string") h[k] = v
    }
  }
  return new Response(JSON.stringify(data), { status, headers: h })
}

export async function handleTestConnection(
  req: Request,
  corsHeaders: Record<string, string>,
  modelRouter: ModelRouter | null,
): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { modelId?: string; baseUrl?: string; apiKey?: string; clearApiKey?: boolean; provider?: string; name?: string }
  const saved = modelRouter?.list ?? configStore.load()
  let testModel: ModelConfig | null = null
  if (body.modelId && (body.apiKey !== undefined || body.baseUrl !== undefined)) {
    const found = saved.find((m) => m.modelId === body.modelId || m.id === body.modelId || m.models?.some((variant) => variant.modelId === body.modelId))
    const variant = found?.models?.find((item) => item.modelId === body.modelId)
    testModel = {
      id: body.modelId,
      name: body.name ?? found?.name ?? "临时测试",
      provider: (body.provider ?? found?.provider ?? "openai-compatible") as ModelConfig["provider"],
      modelId: body.modelId,
      // 前端不会回显 API Key，测试时若前端未传，从后端配置补齐
      apiKey: body.clearApiKey ? "" : body.apiKey || found?.apiKey || "",
      baseUrl: body.baseUrl || found?.baseUrl || "",
      capabilities: variant?.capabilities ?? found?.capabilities ?? ["chat"],
      priority: variant?.priority ?? found?.priority ?? 5,
      costFactor: variant?.costFactor ?? found?.costFactor ?? 1,
      enabled: true,
      contextWindow: variant?.contextWindow ?? found?.contextWindow ?? 128000,
      maxOutputTokens: variant?.maxOutputTokens ?? found?.maxOutputTokens ?? 4096,
    }
  } else {
    const target = body.modelId
      ? resolveSavedModel(saved, body.modelId)
      : saved[0]
    if (!target) return json({ ok: false, error: "没有可用模型" }, { ...corsHeaders, status: 400 })
    testModel = { ...target }
  }

  const collected: string[] = []
  let firstError: string | null = null
  const startedAt = Date.now()
  try {
    for await (const ev of llmClient.stream({
      model: testModel,
      system: "请只回答一行：你的模型名称和提供方。不要寒暄。",
      messages: [{ role: "user", content: "你是哪个模型？modelId 是什么？请只回答一行。" }],
      maxSteps: 1,
    })) {
      if (ev.type === "text-delta") {
        collected.push(ev.text)
        if (collected.join("").length >= 200) break
      } else if (ev.type === "error") {
        firstError = ev.message
        break
      } else if (ev.type === "finish") {
        break
      }
    }
  } catch (err: any) {
    firstError = err?.message ?? String(err)
  }

  const raw = collected.join("").trim()
  const reply = raw
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<思考\b[^>]*>[\s\S]*?<\/思考>/gi, "")
    .trim()
  let effectiveError = reply ? null : firstError
  if (!reply && raw) effectiveError = effectiveError ?? "API 连通，但模型未给出可读回复（可能仅输出思考链）"
  if (reply.includes("未配置 API Key")) effectiveError = "未配置 API Key"
  if (!testModel.apiKey) effectiveError = effectiveError ?? "未配置 API Key"
  const toolProtocol = !effectiveError
    ? await probeNativeToolProtocol(testModel)
    : { status: "unknown" as const, error: "基础连接测试未通过，未执行工具协议探测" }
  return json({
    ok: !effectiveError,
    model: { id: testModel.id, name: testModel.name, provider: testModel.provider, modelId: testModel.modelId, baseUrl: testModel.baseUrl },
    apiKeyPrefix: testModel.apiKey ? "已配置" : "(空)",
    reply: reply.slice(0, 300),
    error: effectiveError,
    toolProtocol,
    elapsedMs: Date.now() - startedAt,
  }, corsHeaders)
}

async function probeNativeToolProtocol(model: ModelConfig): Promise<{
  status: "verified" | "unsupported" | "unknown"
  error?: string
}> {
  const toolName = "__eval_native_tool_probe"
  const nonce = crypto.randomUUID()
  let failure = ""
  let observed = false
  try {
    for await (const event of llmClient.stream({
      model,
      system: "这是自动协议探测。必须调用指定工具一次，不要输出正文。",
      messages: [{
        role: "user",
        content: `调用 ${toolName}，参数 nonce 必须等于 ${nonce}`,
      }],
      tools: [{
        name: toolName,
        description: "验证模型是否支持 API 原生工具调用",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { nonce: { type: "string", const: nonce } },
          required: ["nonce"],
        },
      }],
      toolChoice: { name: toolName },
      maxSteps: 1,
      maxOutputTokens: 128,
      thinkingEnabled: false,
    })) {
      if (event.type === "tool-call"
        && event.name === toolName
        && event.input.nonce === nonce) {
        observed = true
        break
      }
      if (event.type === "error") {
        failure = event.message
        break
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (observed) {
    observeNativeToolProtocolSuccess(model, `connection-probe:${nonce}`)
    return { status: "verified" }
  }
  const reason = failure || "模型没有返回指定的原生工具调用事件"
  const classification = observeNativeToolProtocolFailure({
    model,
    scope: `connection-probe:${nonce}`,
    reason,
    completedWithoutToolCall: !failure,
  })
  if (classification === "transient") {
    return { status: "unknown", error: reason }
  }
  return {
    status: ModelProtocolCapabilityRepo.status(model) === "unsupported"
      ? "unsupported"
      : "unknown",
    error: reason,
  }
}

function resolveSavedModel(configs: ModelConfig[], selector: string): ModelConfig | undefined {
  for (const config of configs) {
    if (config.id === selector || config.modelId === selector) return config
    const variant = config.models?.find((item) => item.id === selector || item.modelId === selector)
    if (variant) return materializeTestModel(config, variant)
  }
  return undefined
}

function materializeTestModel(config: ModelConfig, variant: ModelVariantConfig): ModelConfig {
  return {
    ...config,
    id: `@${config.id}::${variant.id}`,
    name: variant.name,
    modelId: variant.modelId,
    capabilities: variant.capabilities,
    priority: variant.priority,
    costFactor: variant.costFactor,
    enabled: config.enabled && variant.enabled,
    contextWindow: variant.contextWindow,
    maxOutputTokens: variant.maxOutputTokens,
    models: undefined,
  }
}
