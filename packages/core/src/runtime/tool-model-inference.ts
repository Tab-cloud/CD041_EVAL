import type { ModelCapability, ModelConfig } from "../model-router/types.ts"
import type { ToolContext } from "../tool/types.ts"
import { llmClient, type LLMMessage } from "./llm-client.ts"
import {
  isFaultDomainFailure,
  llmManager,
  modelFaultDomain,
  prioritizeFallbackDomains,
  summarizeModelFailure,
} from "./llm-manager.ts"

export interface ToolModelInferenceRequest {
  capability: ModelCapability
  /** Optional pre-resolved order, used by independent verification passes. */
  candidateModels?: ModelConfig[]
  system: string
  messages: (model: ModelConfig, protocolFeedback?: string) => LLMMessage[]
  maxAttempts?: number
  /**
   * Runtime protocol validation belongs at the inference boundary. A transport
   * success with malformed structured output is still a failed attempt.
   */
  validateOutput?: (text: string) => void
  /** Additional attempts allowed after a protocol validation failure. */
  maxProtocolRepairAttempts?: number
  /** Narrow extraction tools should normally disable deep reasoning. */
  thinkingEnabled?: boolean
  /** Workload-specific ceiling; never inherit an unbounded provider maximum. */
  maxOutputTokens?: number
  /** Stable tool operation name used in attempt logs and UI diagnostics. */
  operation?: string
}

export interface ToolModelInferenceResult {
  model: ModelConfig
  text: string
  attempts: number
  continuationSegments: number
}

/**
 * Build the model chain for an inference performed inside a tool.
 *
 * Tool-side inference is part of the active run, so it must preserve an
 * explicitly selected capable model. When that model lacks the requested
 * capability, the tool delegates to a configured specialist instead of
 * pretending the selected model can consume that modality.
 */
export function resolveToolModelCandidates(
  ctx: Pick<ToolContext, "modelRouter" | "preferredModelId" | "fallbackModelIds" | "modelFallbackEnabled">,
  capability: ModelCapability,
): ModelConfig[] {
  const router = ctx.modelRouter
  if (!router) return []

  const eligible = router.list.filter((model) => model.capabilities.includes(capability))
  if (eligible.length === 0) return []

  const preferred = ctx.preferredModelId ? router.getModel(ctx.preferredModelId) : undefined
  const configured = (ctx.fallbackModelIds ?? [])
    .map((id) => router.getModel(id))
    .filter((model): model is ModelConfig => Boolean(model?.capabilities.includes(capability)))
  const primary = preferred?.capabilities.includes(capability)
    ? preferred
    : configured[0] ?? router.getModelForCapability(capability)
  if (!primary) return []
  if (ctx.modelFallbackEnabled === false) return [primary]

  const explicitlyOrdered = configured.filter((model) => model.id !== primary.id)
  const remaining = eligible.filter((model) =>
    model.id !== primary.id && !explicitlyOrdered.some((candidate) => candidate.id === model.id))
  const fallbackPool = explicitlyOrdered.length > 0
    ? [...explicitlyOrdered, ...remaining]
    : llmManager.buildFallbackChain(primary, eligible).filter((model) => model.id !== primary.id)
  return prioritizeFallbackDomains(primary, fallbackPool)
}

/** Execute a capability-specific model call with the run's normal fallback policy. */
export async function runToolModelInference(
  ctx: Pick<ToolContext,
    "modelRouter" | "preferredModelId" | "fallbackModelIds" | "modelFallbackEnabled" | "abortSignal"
    | "runId" | "sessionId" | "agentId" | "executionSegment" | "executionStep" | "onAgentEvent">,
  request: ToolModelInferenceRequest,
): Promise<ToolModelInferenceResult> {
  const candidates = request.candidateModels ?? resolveToolModelCandidates(ctx, request.capability)
  if (candidates.length === 0) throw new Error(`没有配置具备 ${request.capability} 能力的模型`)

  const errors: string[] = []
  const repairAttempts = Math.max(0, request.maxProtocolRepairAttempts ?? 0)
  const candidatePlan = [
    ...candidates,
    ...Array.from({ length: repairAttempts }, (_, index) => candidates[index % candidates.length]!),
  ]
  const attemptLimit = Math.min(Math.max(1, request.maxAttempts ?? 3), candidatePlan.length)
  const failedFaultDomains = new Set<string>()
  let attempts = 0
  let protocolFeedback: string | undefined
  for (let candidateIndex = 0; candidateIndex < candidatePlan.length; candidateIndex++) {
    const model = candidatePlan[candidateIndex]
    if (attempts >= attemptLimit) break
    if (ctx.abortSignal?.aborted) throw new Error("操作已取消")
    const faultDomain = modelFaultDomain(model)
    const attemptContext = {
      runId: ctx.runId ?? ctx.sessionId ?? "unscoped",
      sessionId: ctx.sessionId ?? "unscoped",
      agentId: ctx.agentId ?? "tool",
      scope: "tool" as const,
      operation: request.operation ?? request.capability,
      segment: ctx.executionSegment ?? 0,
      step: ctx.executionStep ?? 0,
      attempt: candidateIndex + 1,
    }
    if (failedFaultDomains.has(faultDomain)) {
      const reason = `${faultDomain} 在本次工具调用中已经发生服务或网络失败`
      const skipped = llmManager.recordCircuitSkip(attemptContext, model, reason)
      emitToolModelAttempt(ctx, skipped, reason)
      errors.push(reason)
      continue
    }
    const availability = llmManager.getModelAvailability(model)
    if (!availability.available) {
      const skipped = llmManager.recordCircuitSkip(
        attemptContext,
        model,
        availability.reason ?? "模型服务暂时熔断",
      )
      emitToolModelAttempt(ctx, skipped, availability.reason)
      errors.push(availability.reason ?? "模型服务暂时熔断")
      continue
    }
    attempts++
    const modelAttempt = llmManager.startModelAttempt(attemptContext, model)
    let text = ""
    let finished = false
    let error = ""
    let continuationSegments = 0
    let inferenceMessages = request.messages(model, protocolFeedback)
    try {
      for (let segment = 0; segment < 4; segment++) {
        let segmentText = ""
        let finishReason = ""
        finished = false
        for await (const event of llmClient.stream({
          model,
          system: request.system,
          messages: inferenceMessages,
          maxSteps: 1,
          thinkingEnabled: request.thinkingEnabled ?? false,
          maxOutputTokens: request.maxOutputTokens,
          signal: ctx.abortSignal,
          usageContext: {
            eventId: `usage:${modelAttempt.id}:${segment}`,
            attemptId: modelAttempt.id,
            runId: ctx.runId ?? ctx.sessionId ?? "unscoped",
            sessionId: ctx.sessionId ?? "unscoped",
            agentId: ctx.agentId ?? "tool",
            scope: "tool",
            operation: request.operation ?? request.capability,
            segment: ctx.executionSegment ?? 0,
            step: ctx.executionStep ?? 0,
          },
        })) {
          if (event.type === "text-delta") segmentText += event.text
          else if (event.type === "error") { error = event.message; break }
          else if (event.type === "finish") {
            finished = true
            finishReason = event.finishReason ?? ""
            break
          }
        }
        const sanitizedSegment = segmentText.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim()
        if (sanitizedSegment) text += `${text ? "\n" : ""}${sanitizedSegment}`
        if (error || !finished || !isOutputLimitFinish(finishReason)) break
        if (!sanitizedSegment) {
          error = "模型达到输出上限但没有返回可续写内容"
          break
        }
        continuationSegments++
        inferenceMessages = [
          ...inferenceMessages,
          { role: "assistant", content: segmentText },
          {
            role: "user",
            content: "上一段因输出长度上限中止。请从中止位置继续，不要重写已经输出的内容；完成剩余表格、证据和结论。",
          },
        ]
        if (segment === 3) error = "模型输出达到自动续写上限"
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const sanitized = text.trim()
    if (finished && sanitized && !error) {
      try {
        request.validateOutput?.(sanitized)
      } catch (validationError) {
        const reason = validationError instanceof Error ? validationError.message : String(validationError)
        const failure = `输出协议验证失败：${reason}`
        const completed = llmManager.finishModelAttempt(modelAttempt.id, "failed", failure)
        if (completed) emitToolModelAttempt(ctx, completed, failure)
        errors.push(failure)
        protocolFeedback = failure.slice(0, 1_000)
        continue
      }
      const completed = llmManager.finishModelAttempt(modelAttempt.id, "succeeded")
      if (completed) emitToolModelAttempt(ctx, completed)
      return { model, text: sanitized, attempts, continuationSegments }
    }
    const failure = error || (finished ? "模型返回空结果" : "模型响应未完整结束")
    const status = ctx.abortSignal?.aborted ? "cancelled" : "failed"
    const completed = llmManager.finishModelAttempt(modelAttempt.id, status, failure)
    if (completed) emitToolModelAttempt(ctx, completed, failure)
    if (status === "cancelled") throw new Error("操作已取消")
    errors.push(failure)
    if (isFaultDomainFailure(failure)) failedFaultDomains.add(faultDomain)
  }
  throw new Error(`能力模型调用失败（实际请求 ${attempts} 次）：${errors.at(-1) ?? "当前没有可用的候选模型"}`)
}

function emitToolModelAttempt(
  ctx: Pick<ToolContext, "onAgentEvent">,
  attempt: import("../store/model-attempt.ts").ModelAttemptView,
  error?: string,
): void {
  ctx.onAgentEvent?.({
    type: "model-attempt",
    attemptId: attempt.id,
    runId: attempt.runId,
    scope: attempt.scope,
    operation: attempt.operation,
    segment: attempt.segment,
    step: attempt.step,
    attempt: attempt.attempt,
    modelId: attempt.modelId,
    modelName: attempt.modelName,
    status: attempt.status,
    failureReason: summarizeModelFailure(error ?? attempt.error),
  })
}

function isOutputLimitFinish(reason: string): boolean {
  return ["length", "max_tokens", "max_output_tokens"].includes(reason.toLowerCase())
}
