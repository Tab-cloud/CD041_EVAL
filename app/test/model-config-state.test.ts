import { describe, expect, test } from "bun:test"
import {
  normalizeModelConfigsForEditor,
  serializeModelConfigs,
  setModelVariantEnabled,
  setProviderEnabled,
} from "../src/model-config-state"
import { buildModelOptions } from "../src/model-options"
import type { ModelConfig } from "../src/types"

describe("model enablement state", () => {
  test("provider is the parent gate and reopening requires explicit child selection", () => {
    let configs = normalizeModelConfigsForEditor([provider(false, [true, false])])
    expect(configs[0].enabled).toBe(false)
    expect(configs[0].models?.map((variant) => variant.enabled)).toEqual([false, false])
    expect(buildModelOptions(configs)).toEqual([])

    configs = setProviderEnabled(configs, "provider", true)
    expect(configs[0].enabled).toBe(true)
    expect(configs[0].models?.map((variant) => variant.enabled)).toEqual([false, false])
    expect(buildModelOptions(configs)).toEqual([])

    configs = setModelVariantEnabled(configs, "provider", "a", true)
    expect(configs[0].enabled).toBe(true)
    expect(buildModelOptions(configs).map((option) => option.id)).toEqual(["@provider::a"])

    configs = setProviderEnabled(configs, "provider", false)
    expect(configs[0].enabled).toBe(false)
    expect(configs[0].models?.map((variant) => variant.enabled)).toEqual([false, false])
    expect(buildModelOptions(configs)).toEqual([])

    configs = setModelVariantEnabled(configs, "provider", "b", true)
    expect(configs[0].models?.map((variant) => variant.enabled)).toEqual([false, false])

    configs = setProviderEnabled(configs, "provider", true)
    expect(configs[0].enabled).toBe(true)
    expect(configs[0].models?.map((variant) => variant.enabled)).toEqual([false, false])
    configs = setModelVariantEnabled(configs, "provider", "b", true)
    expect(buildModelOptions(configs).map((option) => option.id)).toEqual(["@provider::b"])
  })

  test("serialization enforces the parent gate and preserves explicit output limits", () => {
    const [parentDisabled] = serializeModelConfigs([provider(false, [false, true])])
    const [disabled] = serializeModelConfigs([provider(true, [false, false])])

    expect(parentDisabled.enabled).toBe(false)
    expect(parentDisabled.models?.map((variant) => variant.enabled)).toEqual([false, false])
    expect(parentDisabled.modelId).toBe("model-a")
    expect(parentDisabled.maxOutputTokens).toBe(64_000)
    expect(disabled.enabled).toBe(true)
  })
})

function provider(enabled: boolean, variants: boolean[]): ModelConfig {
  return {
    id: "provider",
    name: "Provider",
    provider: "openai-compatible",
    modelId: "model-a",
    apiKey: "",
    baseUrl: "https://example.com/v1",
    capabilities: ["chat"],
    priority: 50,
    costFactor: 1,
    enabled,
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    models: variants.map((variantEnabled, index) => ({
      id: index === 0 ? "a" : "b",
      name: index === 0 ? "A" : "B",
      modelId: index === 0 ? "model-a" : "model-b",
      capabilities: ["chat"],
      priority: 50,
      costFactor: 1,
      enabled: variantEnabled,
      contextWindow: 128_000,
      maxOutputTokens: 64_000,
    })),
  }
}
