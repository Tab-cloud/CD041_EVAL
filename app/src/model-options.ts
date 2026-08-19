import type { ModelConfig } from "./types"

export interface ModelOption {
  id: string
  concreteId: string
  configId: string
  variantId: string
  name: string
  provider: string
  label: string
}

/**
 * Expand enabled model configurations into stable selector values that include
 * the configuration ID, so providers with the same model name remain selectable.
 */
export function buildModelOptions(models: ModelConfig[]): ModelOption[] {
  const options: ModelOption[] = []

  for (const model of models) {
    if (!model.enabled) continue
    const variants = model.models?.length ? model.models : model.modelId.split(",").map((modelId, index) => ({
      id: index === 0 ? "default" : `model-${index + 1}`,
      name: model.modelId.includes(",") ? `${model.name} · ${modelId.trim()}` : model.name,
      modelId: modelId.trim(), enabled: model.enabled,
    }))
    for (const variant of variants) {
      const concreteId = variant.modelId.trim()
      if (!variant.enabled || !concreteId) continue
      options.push({
        id: `@${model.id}::${variant.id}`,
        concreteId,
        configId: model.id,
        variantId: variant.id,
        name: variant.name,
        provider: model.provider,
        label: `${variant.name} · ${concreteId} · ${model.provider}`,
      })
    }
  }

  return options
}

/** Resolve legacy bare model IDs to the first matching qualified option. */
export function resolveModelOptionValue(options: ModelOption[], value: string): string {
  if (options.some((option) => option.id === value)) return value
  if (value.startsWith("@")) {
    const separator = value.indexOf("::")
    const configId = separator > 1 ? value.slice(1, separator) : ""
    const legacySelector = separator > 1 ? value.slice(separator + 2) : ""
    const migrated = options.find((option) => option.configId === configId
      && (option.variantId === legacySelector || option.concreteId === legacySelector))
    if (migrated) return migrated.id
  }
  return options.find((option) => option.concreteId === value)?.id ?? ""
}

/** Convert an internal qualified selector into the user configured model name. */
export function resolveModelDisplayName(models: ModelConfig[], value: string | null, autoLabel: string): string {
  if (!value || value === "auto") return autoLabel
  const options = buildModelOptions(models)
  const resolved = resolveModelOptionValue(options, value)
  return options.find((option) => option.id === resolved)?.name ?? autoLabel
}
