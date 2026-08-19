import type { ModelConfig } from "../model-router/types.ts"
import { ModelProtocolCapabilityRepo } from "../store/model-protocol-capability.ts"
import { isFaultDomainFailure, isQuotaExhaustedFailure } from "./llm-manager.ts"

export type NativeToolFailureClassification = "conclusive" | "transient"

/**
 * A provider/network failure is not evidence about a model's tool protocol.
 * Only a completed forced-tool turn without a native event, or an explicit
 * provider rejection of the tools/tool_choice protocol, is conclusive.
 */
export function classifyNativeToolProtocolFailure(input: {
  reason: string
  completedWithoutToolCall?: boolean
}): NativeToolFailureClassification {
  if (isFaultDomainFailure(input.reason)
    || isQuotaExhaustedFailure(input.reason)
    || /cancel(?:led|ed)|aborted|用户取消/i.test(input.reason)) {
    return "transient"
  }
  if (input.completedWithoutToolCall) return "conclusive"
  return /\b(?:tool_choice|tools?|functions?)\b[\s\S]{0,120}\b(?:unknown|unsupported|unrecognized|invalid|not supported)\b/i.test(input.reason)
    || /\b(?:unknown|unsupported|unrecognized|invalid|not supported)\b[\s\S]{0,120}\b(?:tool_choice|tools?|functions?)\b/i.test(input.reason)
    ? "conclusive"
    : "transient"
}

export function observeNativeToolProtocolSuccess(
  model: ModelConfig,
  scope: string,
): void {
  ModelProtocolCapabilityRepo.observe(model, { kind: "verified", scope })
}

export function observeNativeToolProtocolFailure(input: {
  model: ModelConfig
  scope: string
  reason: string
  completedWithoutToolCall?: boolean
}): NativeToolFailureClassification {
  const classification = classifyNativeToolProtocolFailure(input)
  if (classification === "conclusive") {
    ModelProtocolCapabilityRepo.recordConclusiveFailure(
      input.model,
      input.reason,
      input.scope,
    )
  } else {
    ModelProtocolCapabilityRepo.recordTransientFailure(
      input.model,
      input.reason,
      input.scope,
    )
  }
  return classification
}
