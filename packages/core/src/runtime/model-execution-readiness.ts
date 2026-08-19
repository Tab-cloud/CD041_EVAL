import type { ModelConfig } from "../model-router/types.ts"

export type ModelCredentialStatus = "configured" | "environment" | "not-required" | "missing"

export type ModelExecutionReadinessCode =
  | "ready"
  | "missing-credential"

export interface ModelExecutionReadiness {
  executable: boolean
  code: ModelExecutionReadinessCode
  credentialStatus: ModelCredentialStatus
  reason?: string
}
/**
 * Resolve the credential at the same boundary used by routing and transport.
 * A provider being enabled is an administrative choice; it does not prove the
 * connection is executable. Keeping that distinction in one policy prevents
 * intent analysis, semantic routing, tools, and the main Agent from drifting.
 */
export function resolveModelApiKey(
  model: ModelConfig,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  if (model.apiKey?.trim()) return model.apiKey.trim()
  if (model.provider === "openai") return environment.OPENAI_API_KEY?.trim() || undefined
  if (model.provider === "anthropic") return environment.ANTHROPIC_API_KEY?.trim() || undefined
  return undefined
}

/** Local OpenAI-compatible endpoints are the only supported credential-free transport. */
export function modelRequiresApiKey(model: ModelConfig): boolean {
  return model.provider !== "local"
}

export function evaluateModelExecutionReadiness(
  model: ModelConfig,
  environment: Record<string, string | undefined> = process.env,
): ModelExecutionReadiness {
  const apiKey = resolveModelApiKey(model, environment)
  if (apiKey) {
    return {
      executable: true,
      code: "ready",
      credentialStatus: model.apiKey?.trim() ? "configured" : "environment",
    }
  }
  if (!modelRequiresApiKey(model)) {
    return { executable: true, code: "ready", credentialStatus: "not-required" }
  }
  return {
    executable: false,
    code: "missing-credential",
    credentialStatus: "missing",
    reason: `${model.name} 已启用，但未配置 API Key。请在模型设置中保存凭据，或切换到可用模型。`,
  }
}
