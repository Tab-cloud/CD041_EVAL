import type { ModelConfig, ModelVariantConfig } from "./types"

/** Provider availability is the parent gate for every model below it. */
export function normalizeModelConfigsForEditor(configs: ModelConfig[]): ModelConfig[] {
  return configs.map((config) => {
    const discovered = config.models?.length
      ? config.models.map(cloneVariant)
      : legacyVariants(config)
    const models = config.enabled ? discovered : discovered.map((variant) => ({ ...variant, enabled: false }))
    return { ...config, models }
  })
}

export function setProviderEnabled(
  configs: ModelConfig[],
  configId: string,
  enabled: boolean,
): ModelConfig[] {
  return configs.map((config) => {
    if (config.id !== configId) return config
    return {
      ...config,
      enabled,
      models: enabled
        ? config.models
        : config.models?.map((variant) => ({ ...variant, enabled: false })),
    }
  })
}

export function setModelVariantEnabled(
  configs: ModelConfig[],
  configId: string,
  variantId: string,
  enabled: boolean,
): ModelConfig[] {
  return configs.map((config) => {
    if (config.id !== configId) return config
    if (!config.enabled) return {
      ...config,
      models: config.models?.map((variant) => ({ ...variant, enabled: false })),
    }
    const models = (config.models ?? []).map((variant) => (
      variant.id === variantId ? { ...variant, enabled } : variant
    ))
    return { ...config, models }
  })
}

export function serializeModelConfigs(configs: ModelConfig[]): ModelConfig[] {
  return configs.map((config) => {
    const variants = (config.models ?? []).map((variant) => ({
      ...cloneVariant(variant),
      enabled: config.enabled && variant.enabled,
    }))
    const primary = variants.find((variant) => variant.enabled) ?? variants[0]!
    return {
      ...config,
      modelId: primary.modelId,
      capabilities: primary.capabilities,
      priority: primary.priority,
      costFactor: primary.costFactor,
      enabled: config.enabled,
      contextWindow: primary.contextWindow,
      maxOutputTokens: primary.maxOutputTokens,
      models: variants,
    }
  })
}

export function defaultOutputTokens(contextWindow: number): number {
  const normalized = Number.isFinite(contextWindow)
    ? Math.max(1_024, Math.floor(contextWindow))
    : 128_000
  return Math.min(32_768, Math.max(512, Math.floor(normalized / 4)))
}

function legacyVariants(config: ModelConfig): ModelVariantConfig[] {
  const ids = config.modelId.split(",").map((id) => id.trim()).filter(Boolean)
  return ids.map((modelId, index) => ({
    id: index === 0 ? "default" : `model-${index + 1}`,
    name: ids.length === 1 ? config.name : `${config.name} · ${modelId}`,
    modelId,
    capabilities: [...config.capabilities],
    priority: config.priority,
    costFactor: config.costFactor,
    enabled: true,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
  }))
}

function cloneVariant(variant: ModelVariantConfig): ModelVariantConfig {
  return { ...variant, capabilities: [...variant.capabilities] }
}
