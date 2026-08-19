import type { ModelConfig } from "../model-router/types"
import { contextInputBudget, estimateTokens } from "./context-compaction.ts"
import {
  redactInternalImplementationData,
  redactInternalImplementationDetails,
} from "./model-output-policy.ts"
import {
  recordCompletedModelUsage,
  type ModelUsageContext,
} from "./token-usage-ledger.ts"
import {
  nextModelTransportRetry,
  waitForModelTransportRetry,
} from "./model-transport-retry.ts"

export type LLMEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool-result"; id: string; name: string; result: unknown }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-end" }
  | { type: "finish"; finishReason?: string; usage?: { promptTokens: number; completionTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }; reasoningContent?: string; reasoningDetails?: Array<Record<string, unknown>> }
  | { type: "error"; message: string }
  | {
      type: "transport-retry"
      attempt: number
      maxAttempts: number
      delayMs: number
      reason: string
      failureKind: "request" | "stream"
    }
  // 以下由 agent-loop 产生（非 llm-client 直出），并入联合以便消费者窄化
  | { type: "tool-status"; id: string; name: string; status: string; input?: Record<string, unknown> }
  | {
      type: "context-capacity"
      used: number
      total: number
      breakdown: Record<string, number>
      protocolMessages?: { used: number; total: number }
      usage?: { promptTokens: number; completionTokens: number }
      source?: "model" | "preflight-estimate"
      estimated?: boolean
    }
  | { type: "model-routed"; modelId: string; modelName: string }
  | { type: "tool-stream"; target: string; name: string; text: string; streamType: string }
  | { type: "plan-submitted" }
  | { type: "question-request"; question: import("./user-question").UserQuestionRequest }
  | { type: "question-resolved"; questionId: string }
  | { type: "approval-request"; approval: import("./tool-approval").ToolApprovalRequest }
  | { type: "approval-resolved"; approvalId: string; outcome: import("./tool-approval").ApprovalOutcome }
  | { type: "tool-execution"; execution: import("../store/tool-execution").ToolExecutionView }
  | { type: "agent-activity"; activity: import("../tool/types").AgentActivityEvent }
  | { type: "agent-progress"; phase: "model" | "tools" | "repair" | "finalization"; step: number; maxSteps: number; toolCount?: number }

export interface LLMMessage {
  role: string
  content: string | any[]
  toolCalls?: any[]
  toolResults?: any[]
  reasoningContent?: string
  /** Provider-native separated reasoning blocks required by some interleaved tool protocols. */
  reasoningDetails?: Array<Record<string, unknown>>
  /** Stable configured model identity that produced this assistant transaction. */
  originModelId?: string
}

export interface LLMRequest {
  model: ModelConfig; system: string
  messages: LLMMessage[]
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  /** Runtime recovery may require a native tool call after a text-only no-progress yield. */
  toolChoice?: "auto" | "required" | { name: string }
  maxSteps?: number
  /** Per-call output budget. Workload policy overrides the model's global ceiling. */
  maxOutputTokens?: number
  thinkingEnabled?: boolean  // false → 禁用模型思考（更快速、更便宜）
  signal?: AbortSignal
  /** Durable billing identity supplied by the owning root/tool execution. */
  usageContext?: ModelUsageContext
}

interface ModelFetchLease {
  response: Response
  dispose: () => void
}

async function fetchModelResponse(
  url: string,
  init: Omit<RequestInit, "signal">,
  externalSignal?: AbortSignal,
): Promise<ModelFetchLease> {
  const controller = new AbortController()
  let connectionTimedOut = false
  const timeoutMs = configuredMilliseconds("EVAL_MODEL_CONNECT_TIMEOUT_MS", 120_000, 1_000, 600_000)
  const timer = setTimeout(() => {
    connectionTimedOut = true
    controller.abort(new Error("模型服务连接超时"))
  }, timeoutMs)
  const onAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) onAbort()
  else externalSignal?.addEventListener("abort", onAbort, { once: true })
  const dispose = () => {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onAbort)
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    clearTimeout(timer)
    return { response, dispose }
  } catch (error) {
    dispose()
    if (connectionTimedOut) throw new Error("模型服务连接超时")
    throw error
  }
}

async function readModelStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const timeoutMs = configuredMilliseconds("EVAL_MODEL_STREAM_IDLE_TIMEOUT_MS", 300_000, 1_000, 900_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("模型响应流空闲超时")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function configuredMilliseconds(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function resolveApiKey(model: ModelConfig): string | undefined {
  if (model.apiKey) return model.apiKey
  if (model.provider === "openai") return process.env.OPENAI_API_KEY
  if (model.provider === "anthropic") return process.env.ANTHROPIC_API_KEY
  return undefined
}

function isAnthropicProvider(model: ModelConfig): boolean {
  return model.provider === "anthropic"
}

export function requiresReasoningReplay(model: ModelConfig, thinkingEnabled: boolean | undefined): boolean {
  if (thinkingEnabled === false) return false
  // Strict replay is a protocol capability, not a vendor-name property.
  // OpenAI-compatible reasoning endpoints (including models behind aliases or
  // proxies) may reject historical tool calls that lack reasoning_content.
  // This function is used by the OpenAI-compatible protocol path. Conservatively
  // fold unverifiable transactions for any model configured with reasoning
  // capability; native transactions with captured reasoning still replay.
  return model.capabilities.includes("reasoning")
}

/**
 * Project the canonical conversation ledger into OpenAI-compatible wire messages.
 *
 * Some reasoning APIs require the exact reasoning payload to accompany every
 * replayed assistant tool call. A completed transaction created by another
 * model (or restored from legacy storage without reasoning) cannot satisfy that
 * contract. Replaying it as raw tool protocol causes HTTP 400, so it is folded
 * into an ordinary assistant/user evidence pair while preserving its semantics.
 */
export function projectOpenAIMessages(
  system: string,
  source: LLMMessage[],
  options: { supportsVision: boolean; requireReasoningReplay: boolean; currentModelId: string },
): any[] {
  const projected: any[] = [{ role: "system", content: system }]
  const openToolCallIds = new Set<string>()
  for (let index = 0; index < source.length; index++) {
    const message = source[index]
    if (message.role === "system") continue
    if (message.toolCalls?.length) {
      const replayable = !options.requireReasoningReplay
        || Boolean(
          (message.reasoningContent || message.reasoningDetails?.length)
          && (!message.originModelId || message.originModelId === options.currentModelId),
        )
      if (!replayable) {
        projected.push({ role: "assistant", content: historicalToolCallSummary(message) })
        const resultMessage = source[index + 1]
        if (resultMessage?.toolResults?.length) {
          projected.push({ role: "user", content: historicalToolResultSummary(resultMessage.toolResults) })
          index++
        }
        continue
      }
      const assistantMessage: any = {
        role: "assistant",
        content: sanitizeModelContent(message.content, options.supportsVision) || null,
        tool_calls: message.toolCalls.map((call: any) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        })),
      }
      if (message.reasoningContent) assistantMessage.reasoning_content = message.reasoningContent
      if (message.reasoningDetails?.length) assistantMessage.reasoning_details = message.reasoningDetails
      projected.push(assistantMessage)
      message.toolCalls.forEach((call: any) => openToolCallIds.add(String(call.id ?? "")))
      continue
    }
    if (message.toolResults?.length) {
      const replayableResults = message.toolResults.filter((result: any) => openToolCallIds.has(String(result.id ?? "")))
      if (options.requireReasoningReplay && replayableResults.length !== message.toolResults.length) {
        // Orphaned legacy tool results have no replayable assistant transaction.
        projected.push({ role: "user", content: historicalToolResultSummary(message.toolResults) })
        replayableResults.forEach((result: any) => openToolCallIds.delete(String(result.id ?? "")))
      } else {
        for (const result of message.toolResults) {
          projected.push({
            role: "tool",
            tool_call_id: result.id,
            content: typeof result.result === "string" ? result.result : JSON.stringify(result.result),
          })
          openToolCallIds.delete(String(result.id ?? ""))
        }
      }
      continue
    }
    projected.push({ role: message.role, content: sanitizeModelContent(message.content, options.supportsVision) })
  }
  return projected
}

/**
 * Estimate the canonical history after applying the same protocol projection
 * used for the next model request. This prevents compaction pressure from
 * counting raw foreign tool ledgers that will be folded into bounded evidence.
 */
export function estimateProjectedHistoryTokens(
  model: ModelConfig,
  history: LLMMessage[],
  thinkingEnabled: boolean | undefined = true,
): number {
  return estimateProjectedHistoryShape(model, history, thinkingEnabled).tokens
}

export function estimateProjectedHistoryShape(
  model: ModelConfig,
  history: LLMMessage[],
  thinkingEnabled: boolean | undefined = true,
): { tokens: number; messages: number } {
  if (isAnthropicProvider(model)) return { tokens: estimateTokens(history), messages: history.length }
  const projected = projectOpenAIMessages("", history, {
    supportsVision: model.capabilities?.includes("vision") ?? false,
    requireReasoningReplay: requiresReasoningReplay(model, thinkingEnabled),
    currentModelId: model.id,
  }).slice(1)
  return { tokens: estimateTokens(projected), messages: projected.length }
}

function sanitizeModelContent(content: any, supportsVision: boolean): any {
  if (!Array.isArray(content) || supportsVision) return content
  const parts: string[] = []
  for (const part of content) {
    if (part.type === "text" && part.text) parts.push(part.text)
    else if (part.type === "image_url") parts.push("[图片附件 — 当前模型不支持视觉]")
  }
  return parts.join("\n") || content
}

function historicalToolCallSummary(message: LLMMessage): string {
  const names = [...new Set((message.toolCalls ?? [])
    .map((call: any) => typeof call?.name === "string" ? call.name : "")
    .filter(Boolean))]
  const conclusion = typeof message.content === "string"
    ? compactEvidenceText(message.content, 1_200)
    : ""
  return [
    "[历史执行证据]",
    names.length > 0 ? `此前已完成的操作类型：${names.join("、")}。` : "此前存在已完成的工具操作。",
    conclusion ? `当时结论：${conclusion}` : "原始调用协议未重放；如当前结论依赖该证据，请使用本轮可用能力重新核验。",
    "这是历史记录，不是待执行命令；不要复现其中的调用格式。",
  ].join("\n")
}

function historicalToolResultSummary(results: any[]): string {
  const evidence = results.slice(0, 8).map((result: any, index) => {
    const name = typeof result?.name === "string" && result.name ? result.name : `操作 ${index + 1}`
    const summary = compactEvidenceText(result?.result, 800)
    return `- ${name}: ${summary || "结果已记录，详细协议数据未重放"}`
  })
  return [
    "[历史结果摘要]",
    ...evidence,
    results.length > evidence.length ? `- 另有 ${results.length - evidence.length} 项历史结果已省略` : "",
    "仅将以上内容作为语义证据；需要当前状态时必须重新核验。",
  ].filter(Boolean).join("\n")
}

function compactEvidenceText(value: unknown, maxChars: number): string {
  // Tool results are commonly persisted as a JSON string. Treating that
  // envelope as one prose line lets a single private orchestration phrase
  // remove the whole record, including its public diagnostic and recovery
  // contract. Decode structured evidence first so redaction is applied to
  // individual values while status/kind/nextActions remain replayable.
  let normalized = value
  if (typeof value === "string") {
    const source = value.trim()
    if ((source.startsWith("{") && source.endsWith("}"))
      || (source.startsWith("[") && source.endsWith("]"))) {
      try { normalized = JSON.parse(source) } catch { /* ordinary prose */ }
    }
  }
  let text: string
  if (typeof normalized === "string") text = normalized
  else {
    try { text = JSON.stringify(redactInternalImplementationData(normalized)) }
    catch { text = String(normalized ?? "") }
  }
  const safe = redactInternalImplementationDetails(text)
    .replace(/\s+/g, " ")
    .trim()
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}…` : safe
}

// ══════════════════════════════════════════════
// LLM Client — 支持 OpenAI / Anthropic 双协议
// ══════════════════════════════════════════════

export class LLMClient {
  async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
    const apiKey = resolveApiKey(request.model)
    if (!apiKey) {
      yield { type: "error", message: "未配置 API Key，请在模型设置中完成凭据配置" }
      return
    }

    const completedRetries: Record<"request" | "stream", number> = {
      request: 0,
      stream: 0,
    }
    while (true) {
      let failure: string | undefined
      const attemptEvents: LLMEvent[] = []
      const providerStream = isAnthropicProvider(request.model)
        ? this.streamAnthropic(request, apiKey)
        : this.streamOpenAI(request, apiKey)
      for await (const event of providerStream) {
        if (event.type === "error") {
          failure = event.message
          break
        }
        attemptEvents.push(event)
      }
      if (!failure) {
        if (request.usageContext) {
          try {
            recordCompletedModelUsage({
              context: request.usageContext,
              model: request.model,
              system: request.system,
              messages: request.messages,
              tools: request.tools,
              events: attemptEvents,
            })
          } catch (error) {
            console.warn("Token 用量账本写入失败:", error)
          }
        }
        for (const event of attemptEvents) yield event
        return
      }
      if (request.signal?.aborted) {
        yield { type: "error", message: "模型调用已取消" }
        return
      }
      const requestRetry = nextModelTransportRetry(failure, completedRetries.request)
      const streamRetry = nextModelTransportRetry(failure, completedRetries.stream)
      const retry = streamRetry?.failureKind === "stream"
        ? streamRetry
        : requestRetry
      if (!retry) {
        yield { type: "error", message: failure }
        return
      }
      completedRetries[retry.failureKind]++
      yield { type: "transport-retry", ...retry }
      try {
        await waitForModelTransportRetry(retry.delayMs, request.signal)
      } catch {
        yield { type: "error", message: "模型调用已取消" }
        return
      }
    }
  }

  // ── OpenAI / OpenAI-Compatible 协议 ──

  private async *streamOpenAI(request: LLMRequest, apiKey: string): AsyncGenerator<LLMEvent> {
    const modelId = request.model.modelId.split(",")[0].trim()
    const baseURL = (request.model.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")
    const url = `${baseURL}/chat/completions`

    const supportsVision = request.model.capabilities?.includes("vision") ?? false
    const messages = projectOpenAIMessages(request.system, request.messages, {
      supportsVision,
      requireReasoningReplay: requiresReasoningReplay(request.model, request.thinkingEnabled),
      currentModelId: request.model.id,
    })

    const tools = this.buildOpenAITools(request.tools)
    const body: any = {
      model: modelId, messages, stream: true, temperature: 0.3,
      stream_options: { include_usage: true },
    }
    // OpenAI-compatible is an explicit protocol selection. Never infer request
    // fields from modelId; aliases and proxy names make that non-deterministic.
    const outputLimit = request.maxOutputTokens ?? request.model.maxOutputTokens ?? 4096
    body.max_tokens = outputLimit
    // Reasoning-capable OpenAI-compatible endpoints do not share one wire
    // representation. Prefer the separated format because it is the only
    // format that can be replayed losslessly across interleaved tool rounds.
    // Capability negotiation below removes the field when an endpoint rejects
    // it; no provider or model identifier is used as runtime policy.
    if (requiresReasoningReplay(request.model, request.thinkingEnabled)) {
      body.reasoning_split = true
    }
    if (tools.length > 0) {
      body.tools = tools
      if (request.toolChoice === "required") body.tool_choice = "required"
      else if (typeof request.toolChoice === "object") {
        body.tool_choice = { type: "function", function: { name: request.toolChoice.name } }
      }
    }
    // OpenAI SDK 的 extra_body 是客户端参数；在线协议中扩展字段位于
    // JSON 顶层。直接 fetch 时不得把字面量 "extra_body" 发给服务端。
    if (request.thinkingEnabled === false) {
      body.thinking = { type: "disabled" }
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let responseLease: ModelFetchLease | undefined
    try {
      // 最终安全网：为输出和协议误差预留空间，逐条裁剪旧历史并重新计算。
      // 正常的语义压缩由 server-context 提前完成；这里负责单轮工具结果膨胀等极端情况。
      const inputBudget = contextInputBudget(
        request.model.contextWindow ?? 128000,
        outputLimit,
      )
      if (estimateTokens(body) > inputBudget) {
        const sysMsg = messages[0]
        let kept = messages.slice(1)
        while (kept.length > 1 && estimateTokens({ ...body, messages: [sysMsg, ...kept] }) > inputBudget) {
          kept = kept.slice(1)
          // 配对保护：截断后不以孤立的 role="tool" 消息开头。
          while (kept.length > 1 && kept[0].role === "tool") kept = kept.slice(1)
        }
        body.messages = [sysMsg, ...kept]
        if (request.tools?.length) body.tools = this.buildOpenAITools(request.tools)
        if (estimateTokens(body) > inputBudget) {
          throw new Error(`上下文仍超出安全输入预算 (${estimateTokens(body)}/${inputBudget} tokens)，请减少单条附件或工具输出`)
        }
      }
      let resp: Response | undefined
      let lastStatus = 0
      let lastError = ""
      for (let negotiationAttempt = 0; negotiationAttempt < 4; negotiationAttempt++) {
        responseLease?.dispose()
        responseLease = await fetchModelResponse(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        }, request.signal)
        resp = responseLease.response
        if (resp.ok) break
        lastStatus = resp.status
        lastError = await resp.text()
        if (body.reasoning_split && isUnsupportedReasoningSplitError(lastError)) {
          delete body.reasoning_split
          continue
        }
        if (body.tool_choice && isThinkingToolChoiceConflictError(lastError)
          && body.thinking?.type !== "disabled") {
          delete body.reasoning_split
          body.thinking = { type: "disabled" }
          continue
        }
        // Compatible gateways disagree on max_tokens support and upper bounds.
        // Retry without the optional cap; finish-reason continuation still
        // protects long output if the provider applies a smaller native limit.
        if (body.max_tokens && isOutputLimitConfigurationError(lastError)) {
          delete body.max_tokens
          continue
        }
        break
      }
      if (!resp?.ok) throw new Error(`HTTP ${lastStatus || resp?.status || 500}: ${lastError.slice(0, 200)}`)

      reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""; let fullText = ""; let fullReasoning = ""; let thinkingStarted = false; let streamDone = false; let finishReason = ""
      let fullReasoningDetails: Array<Record<string, unknown>> | undefined
      const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>()
      let streamUsage: { promptTokens: number; completionTokens: number } | undefined
      let parsedChunks = 0
      let choiceChunks = 0

      while (!streamDone) {
        const { done, value } = await readModelStreamChunk(reader)
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n"); buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!/^data:/i.test(line)) continue
          const data = line.replace(/^data:\s*/i, "").trim()
          if (data === "[DONE]") { streamDone = true; break }
          try {
            const chunk = JSON.parse(data)
            parsedChunks++
            if (chunk?.error) throw new Error(providerStreamError(chunk.error))
            const choice = chunk.choices?.[0]
            const delta = choice?.delta ?? choice?.message
            if (choice) choiceChunks++
            if (choice?.finish_reason) finishReason = String(choice.finish_reason)
            if (chunk.usage) streamUsage = { promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0 }
            const reasoningDetails = normalizeReasoningDetails(delta?.reasoning_details)
            const separatedReasoning = reasoningDetailsText(reasoningDetails)
            if (reasoningDetails.length > 0) {
              fullReasoningDetails = reasoningDetails
              const appended = appendCompatibleStreamText(fullReasoning, separatedReasoning)
              fullReasoning = appended.full
              if (appended.delta) {
                if (!thinkingStarted) { thinkingStarted = true; yield { type: "thinking-start" } }
                yield { type: "thinking-delta", text: appended.delta }
              }
            } else if (delta?.reasoning_content) {
              if (!thinkingStarted) { thinkingStarted = true; yield { type: "thinking-start" } }
              const appended = appendCompatibleStreamText(fullReasoning, String(delta.reasoning_content))
              fullReasoning = appended.full
              if (appended.delta) yield { type: "thinking-delta", text: appended.delta }
            }
            const deltaContent = compatibleContentText(delta?.content)
            if (deltaContent) {
              if (thinkingStarted && !fullText) { yield { type: "thinking-end" }; thinkingStarted = false }
              const appended = appendCompatibleStreamText(fullText, deltaContent)
              fullText = appended.full
              if (appended.delta) yield { type: "text-delta", text: appended.delta }
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { id: tc.id ?? `tc-${Date.now()}-${idx}`, name: tc.function?.name ?? "", arguments: "" })
                const acc = toolCallAcc.get(idx)!
                if (tc.id) acc.id = tc.id
                if (tc.function?.name) acc.name = tc.function.name
                if (tc.function?.arguments) acc.arguments += tc.function.arguments
              }
            }
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("模型服务流式错误")) throw error
          }
        }
      }
      if (!streamDone && !finishReason) throw new Error("模型响应流在完成前中断")
      if (parsedChunks === 0) throw new Error("模型服务返回了空的流式协议")
      if (choiceChunks === 0) throw new Error("模型服务未返回可识别的响应选项")
      if (!fullText && toolCallAcc.size === 0) {
        if (/length|max_tokens/i.test(finishReason)) throw new Error("模型输出预算在产生正文或工具调用前耗尽")
        if (/content_filter/i.test(finishReason)) throw new Error("模型响应被服务端内容策略拦截")
      }
      if (thinkingStarted) yield { type: "thinking-end" }
      for (const [, acc] of toolCallAcc) {
        let input: Record<string, unknown> = {}
        if (acc.arguments) { try { input = JSON.parse(acc.arguments) } catch { input = { _raw: acc.arguments } } }
        if (acc.name) yield { type: "tool-call", id: acc.id, name: acc.name, input }
      }
      yield {
        type: "finish",
        finishReason: finishReason || undefined,
        reasoningContent: fullReasoning || undefined,
        reasoningDetails: fullReasoningDetails,
        usage: streamUsage,
      }
    } catch (err: any) {
      const message = describeLlmError(err, baseURL)
      console.error("[llm:openai]", message)
      yield { type: "error", message }
    } finally {
      if (reader) await reader.cancel().catch(() => {})
      responseLease?.dispose()
    }
  }

  // ── Anthropic 原生协议 ──

  private async *streamAnthropic(request: LLMRequest, apiKey: string): AsyncGenerator<LLMEvent> {
    const modelId = request.model.modelId.split(",")[0].trim()
    const baseURL = (request.model.baseUrl || "https://api.anthropic.com").replace(/\/$/, "")
    // Anthropic base 可能是根路径 (https://api.anthropic.com) 或已包含 /v1，避免重复拼接
    const url = baseURL.endsWith("/v1") ? `${baseURL}/messages` : `${baseURL}/v1/messages`

    // 构建 Anthropic 消息
    const anthropicMessages: any[] = []
    for (const m of request.messages) {
      if (m.role === "system") continue
      if (m.toolCalls && m.toolCalls.length > 0) {
        // Assistant 消息含 tool_use content blocks
        const content: any[] = []
        if (m.content) content.push({ type: "text", text: m.content as string })
        for (const tc of m.toolCalls!) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input ?? {} })
        }
        anthropicMessages.push({ role: "assistant", content })
      } else if (m.toolResults && m.toolResults.length > 0) {
        // Tool result → user 消息含 tool_result content blocks
        const content: any[] = []
        for (const tr of m.toolResults) {
          const text = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result)
          content.push({ type: "tool_result", tool_use_id: tr.id, content: text })
        }
        anthropicMessages.push({ role: "user", content })
      } else if (typeof m.content === "string") {
        anthropicMessages.push({ role: m.role, content: m.content })
      } else if (Array.isArray(m.content)) {
        // Multimodal: 转换 OpenAI image_url → Anthropic image source
        const anthropicContent: any[] = []
        for (const part of m.content) {
          if (part.type === "text") {
            anthropicContent.push({ type: "text", text: part.text })
          } else if (part.type === "image_url" && part.image_url?.url) {
            const url: string = part.image_url.url
            if (url.startsWith("data:")) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/)
              if (match) {
                anthropicContent.push({
                  type: "image",
                  source: { type: "base64", media_type: match[1], data: match[2] },
                })
              }
            }
          }
        }
        anthropicMessages.push({ role: m.role, content: anthropicContent })
      }
    }

    const tools = this.buildAnthropicTools(request.tools)
    const outputLimit = request.maxOutputTokens ?? request.model.maxOutputTokens ?? 4096
    const body: any = {
      model: modelId, messages: anthropicMessages, stream: true,
      max_tokens: outputLimit,
      temperature: 0.3,
    }
    if (request.system) body.system = request.system
    if (tools.length > 0) {
      body.tools = tools
      if (request.toolChoice === "required") body.tool_choice = { type: "any" }
      else if (typeof request.toolChoice === "object") {
        body.tool_choice = { type: "tool", name: request.toolChoice.name }
      }
    }
    // 思考开关：关闭时禁用 Anthropic 的 extended thinking
    if (request.thinkingEnabled === false) {
      body.thinking = { type: "disabled" }
    }

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let responseLease: ModelFetchLease | undefined
    try {
      const inputBudget = contextInputBudget(
        request.model.contextWindow ?? 128000,
        outputLimit,
      )
      if (estimateTokens(body) > inputBudget) {
        let kept = [...anthropicMessages]
        // 配对保护：截断后不以孤立的 tool_result(user) 消息开头
        // （其对应的 assistant(tool_use) 已被截断，Anthropic API 会报错）
        const isOrphanToolResult = (msg: any) =>
          msg?.role === "user" && Array.isArray(msg.content) &&
          msg.content.length > 0 && msg.content.every((b: any) => b.type === "tool_result")
        while (kept.length > 1 && estimateTokens({ ...body, messages: kept }) > inputBudget) {
          kept = kept.slice(1)
          while (kept.length > 1 && isOrphanToolResult(kept[0])) kept = kept.slice(1)
        }
        body.messages = kept
        if (request.system) body.system = request.system
        if (estimateTokens(body) > inputBudget) {
          throw new Error(`上下文仍超出安全输入预算 (${estimateTokens(body)}/${inputBudget} tokens)，请减少单条附件或工具输出`)
        }
      }
      responseLease = await fetchModelResponse(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      }, request.signal)
      let resp = responseLease.response
      if (!resp.ok) {
        const firstError = await resp.text()
        if (isOutputLimitConfigurationError(firstError)) {
          body.max_tokens = fallbackRequiredOutputLimit(body.max_tokens, firstError)
          responseLease.dispose()
          responseLease = await fetchModelResponse(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
          }, request.signal)
          resp = responseLease.response
        } else {
          throw new Error(`HTTP ${resp.status}: ${firstError.slice(0, 200)}`)
        }
      }
      if (!resp.ok) { const e = await resp.text(); throw new Error(`HTTP ${resp.status}: ${e.slice(0, 200)}`) }

      // 解析 Anthropic SSE 流
      reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""; let fullText = ""; let fullReasoning = ""; let thinkingStarted = false
      let streamDone = false
      let stopReason = ""
      const toolCallAcc = new Map<number, { id: string; name: string; inputAcc: string }>()
      let streamUsage: { promptTokens: number; completionTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number } | undefined

      while (!streamDone) {
        const { done, value } = await readModelStreamChunk(reader)
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n"); buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim()
            try {
              const chunk = JSON.parse(data)

              // ── Usage ──
              if (chunk.usage) {
                streamUsage = {
                  promptTokens: chunk.usage.input_tokens ?? 0,
                  completionTokens: chunk.usage.output_tokens ?? 0,
                  cacheCreationInputTokens: chunk.usage.cache_creation_input_tokens,
                  cacheReadInputTokens: chunk.usage.cache_read_input_tokens,
                }
              }

              // ── Content block delta (text / thinking) ──
              if (chunk.type === "content_block_delta") {
                const delta = chunk.delta
                if (delta?.type === "text_delta") {
                  if (thinkingStarted && !fullText) { yield { type: "thinking-end" }; thinkingStarted = false }
                  fullText += delta.text
                  yield { type: "text-delta", text: delta.text }
                } else if (delta?.type === "thinking_delta") {
                  if (!thinkingStarted) { thinkingStarted = true; yield { type: "thinking-start" } }
                  fullReasoning += delta.thinking
                  yield { type: "thinking-delta", text: delta.thinking }
                } else if (delta?.type === "input_json_delta") {
                  // Tool use 参数增量 — 累积到对应 index
                  const idx = chunk.index ?? 0
                  if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { id: "", name: "", inputAcc: "" })
                  toolCallAcc.get(idx)!.inputAcc += delta.partial_json ?? ""
                }
              }

              // ── Content block start (text / tool_use / thinking) ──
              if (chunk.type === "content_block_start") {
                const block = chunk.content_block
                if (block?.type === "tool_use") {
                  const idx = chunk.index ?? 0
                  toolCallAcc.set(idx, { id: block.id || crypto.randomUUID(), name: block.name ?? "", inputAcc: "" })
                } else if (block?.type === "thinking") {
                  // thinking block started — will receive thinking_delta
                }
              }

              // ── Message delta (stop reason) ──
              if (chunk.type === "message_delta") {
                if (chunk.delta?.stop_reason) stopReason = String(chunk.delta.stop_reason)
                if (chunk.usage) {
                  streamUsage = {
                    promptTokens: chunk.usage.input_tokens ?? (streamUsage?.promptTokens ?? 0),
                    completionTokens: chunk.usage.output_tokens ?? (streamUsage?.completionTokens ?? 0),
                  }
                }
              }

              // ── Message stop ──
              if (chunk.type === "message_stop") {
                streamDone = true
              }
            } catch {}
          }
        }
      }

      if (!streamDone) throw new Error("模型响应流在完成前中断")

      if (thinkingStarted) yield { type: "thinking-end" }

      // Yield 完整 tool-call
      for (const [, acc] of toolCallAcc) {
        if (!acc.name) continue
        let input: Record<string, unknown> = {}
        if (acc.inputAcc) { try { input = JSON.parse(acc.inputAcc) } catch { input = { _raw: acc.inputAcc } } }
        yield { type: "tool-call", id: acc.id, name: acc.name, input }
      }

      yield { type: "finish", finishReason: stopReason || undefined, reasoningContent: fullReasoning || undefined, usage: streamUsage }
    } catch (err: any) {
      const message = describeLlmError(err, baseURL)
      console.error("[llm:anthropic]", message)
      yield { type: "error", message }
    } finally {
      if (reader) await reader.cancel().catch(() => {})
      responseLease?.dispose()
    }
  }

  // ── 工具定义转换 ──

  private buildOpenAITools(tools?: LLMRequest["tools"]): any[] {
    if (!tools) return []
    return tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }

  private buildAnthropicTools(tools?: LLMRequest["tools"]): any[] {
    if (!tools) return []
    return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
}

function isOutputLimitConfigurationError(message: string): boolean {
  return /max[_ -]?(?:output[_ -]?)?tokens?|output token|generation limit/i.test(message)
}

function isUnsupportedReasoningSplitError(message: string): boolean {
  return /reasoning_split/i.test(message)
    && /unknown|unsupported|unrecognized|unexpected|invalid|extra|not (?:allowed|permitted|supported)/i.test(message)
}

function isThinkingToolChoiceConflictError(message: string): boolean {
  return /think(?:ing)?[\s\S]{0,80}tool[_\s-]?choice|tool[_\s-]?choice[\s\S]{0,80}think(?:ing)?/i.test(message)
}

function normalizeReasoningDetails(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ ...item }))
}

function reasoningDetailsText(details: Array<Record<string, unknown>>): string {
  return details
    .map((detail) => typeof detail.text === "string"
      ? detail.text
      : typeof detail.reasoning === "string" ? detail.reasoning : "")
    .join("")
}

function compatibleContentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.map((part) => {
    if (typeof part === "string") return part
    if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text
    return ""
  }).join("")
}

function providerStreamError(value: unknown): string {
  if (typeof value === "string") return `模型服务流式错误: ${value.slice(0, 240)}`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const message = typeof record.message === "string" ? record.message
      : typeof record.code === "string" ? record.code
        : "服务端拒绝了当前请求"
    return `模型服务流式错误: ${message.slice(0, 240)}`
  }
  return "模型服务流式错误: 服务端拒绝了当前请求"
}

/**
 * OpenAI streams normally emit token deltas, while some compatible endpoints
 * emit the full cumulative text on every chunk. Accept both without provider
 * or model-name branching.
 */
function appendCompatibleStreamText(current: string, incoming: string): { full: string; delta: string } {
  if (!incoming) return { full: current, delta: "" }
  if (incoming === current) return { full: current, delta: "" }
  if (incoming.startsWith(current)) return { full: incoming, delta: incoming.slice(current.length) }
  return { full: current + incoming, delta: incoming }
}

export function fallbackRequiredOutputLimit(current: number, message: string): number {
  const explicit = [
    /(?:less than or equal to|at most|maximum(?: allowed)?(?: is| of)?)\s*([0-9][0-9,]*)/i,
    /max[_ -]?(?:output[_ -]?)?tokens?[^0-9]{0,40}([0-9][0-9,]*)/i,
  ].map((pattern) => Number(message.match(pattern)?.[1]?.replace(/,/g, "")))
    .find((value) => Number.isFinite(value) && value >= 512)
  if (explicit) return Math.min(current, explicit)
  return Math.max(512, Math.min(32_768, Math.floor(current / 2)))
}

export const llmClient = new LLMClient()

export function describeLlmError(error: unknown, baseUrl: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  let endpoint = "模型服务"
  try { endpoint = new URL(baseUrl).host || endpoint } catch {}
  if (/network error|failed to fetch|fetch failed|econnrefused|econnreset|enotfound|socket|dns/i.test(raw)) {
    return `无法连接模型服务 ${endpoint}，请检查 Base URL、网络或代理设置`
  }
  if (/timed? ?out|timeout|aborterror/i.test(raw)) {
    return `模型服务 ${endpoint} 请求超时，请检查网络或稍后重试`
  }
  return `模型 API 调用失败: ${raw.slice(0, 300)}`
}
