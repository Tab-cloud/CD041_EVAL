import type {
  ModelCapability,
  ModelConfig,
  ModelExecutionEligibility,
  ModelExecutionEligibilityPolicy,
  ModelVariantConfig,
  RoutingDecision,
} from "./types.ts"

/**
 * 模型路由器
 *
 * 根据任务需求 + 用户配置的模型列表，自动选择最优模型。
 * 路由依据是 agent.requiredCapabilities（静态能力标签），不感知任务文本——
 * 任务文本→agent 的映射由 AgentOrchestrator 负责（两者正交，见 orchestrator.ts）。
 * 局限：同一 agent 无论子任务差异，都路由到同一模型；agent-loop 已对图片附件
 * 做了轻量动态调整（有图时优先 vision 模型）。
 */
export class ModelRouter {
  private _configs: ModelConfig[] = []
  private readonly eligibility: ModelExecutionEligibilityPolicy

  /** Executable models only. Administrative enablement alone is insufficient. */
  get list(): ModelConfig[] {
    return this.configuredList.filter((model) => this.eligibility(model).executable)
  }

  /** Administratively enabled provider/model selections, including unavailable connections. */
  get configuredList(): ModelConfig[] {
    return this._configs.flatMap((config) => variantsFor(config)
      .filter((variant) => variant.enabled)
      .map((variant) => materialize(config, variant)))
  }

  constructor(models: ModelConfig[], options?: { eligibility?: ModelExecutionEligibilityPolicy }) {
    this.eligibility = options?.eligibility ?? (() => ({ executable: true }))
    this._configs = models.filter(hasEnabledModel)
  }

  /**
   * 更新模型列表
   */
  updateModels(models: ModelConfig[]): void {
    this._configs = models.filter(hasEnabledModel)
  }

  /** 按配置 ID 或逗号分隔配置中的具体模型 ID 选择模型。 */
  getModel(id: string): ModelConfig | undefined {
    const model = this.getConfiguredModel(id)
    return model && this.eligibility(model).executable ? model : undefined
  }

  /** Resolve an enabled selection even when its connection is not executable. */
  getConfiguredModel(id: string): ModelConfig | undefined {
    const separator = id.startsWith("@") ? id.indexOf("::") : -1
    if (separator > 1) {
      const configId = id.slice(1, separator)
      const variantSelector = id.slice(separator + 2)
      const config = this._configs.find((model) => model.id === configId)
      const variant = config && variantsFor(config).find((item) => item.enabled && (item.id === variantSelector || item.modelId === variantSelector))
      return config && variant ? materialize(config, variant) : undefined
    }
    for (const config of this._configs) {
      const variants = variantsFor(config).filter((variant) => variant.enabled)
      const variant = config.id === id ? variants[0] : variants.find((item) => item.modelId === id)
      if (variant) return materialize(config, variant)
    }
    return undefined
  }

  getModelEligibility(id: string): ModelExecutionEligibility | undefined {
    const model = this.getConfiguredModel(id)
    return model ? this.eligibility(model) : undefined
  }

  /**
   * 为核心路由方法：给定所需能力，返回最优模型
   */
  route(requiredCapabilities: ModelCapability[]): RoutingDecision {
    const models = this.list
    if (models.length === 0) {
      throw new Error("没有可用的模型配置")
    }

    const hardCapabilities = requiredCapabilities.filter(isTransportCapability)
    const eligible = models.filter((model) => hardCapabilities.every((capability) => model.capabilities.includes(capability)))
    if (eligible.length === 0) {
      throw new Error(`没有模型支持输入协议所需能力: ${hardCapabilities.join(", ")}`)
    }

    // Quality capabilities are preferences, not admission gates. This keeps a
    // missing or stale metadata tag from terminating an otherwise executable
    // task. Ties follow the explicit route order (1 is highest), then cost.
    const ranked = eligible.map((model, index) => ({
      model,
      index,
      score: capabilityCoverage(model, requiredCapabilities),
    }))
    ranked.sort((a, b) => b.score - a.score
      || a.model.priority - b.model.priority
      || a.model.costFactor - b.model.costFactor
      || a.index - b.index)

    const best = ranked[0]
    const matchedCapability = this.bestMatchingCapability(best.model, requiredCapabilities)

    return {
      model: best.model,
      matchedCapability,
      score: best.score,
      alternatives: ranked.slice(1, 4).map((item) => item.model),
      reason: this.buildReason(best.model, best.score, requiredCapabilities),
    }
  }

  /**
   * 获取特定能力的模型
   */
  getModelForCapability(capability: ModelCapability): ModelConfig | undefined {
    const exact = this.list.filter((model) => model.capabilities.includes(capability))
    const candidates = (exact.length > 0 ? exact : isTransportCapability(capability) ? [] : this.list)
      .sort((a, b) => a.priority - b.priority || a.costFactor - b.costFactor)

    return candidates[0]
  }

  /**
   * 找到模型最匹配的单个能力
   */
  private bestMatchingCapability(model: ModelConfig, required: ModelCapability[]): ModelCapability {
    // 按优先级: vision > coding > reasoning > search > chat
    const priority: ModelCapability[] = ["vision", "coding", "reasoning", "search", "chat"]
    for (const cap of priority) {
      if (required.includes(cap) && model.capabilities.includes(cap)) {
        return cap
      }
    }
    return model.capabilities[0]
  }

  /**
   * 生成路由决策说明
   */
  private buildReason(
    model: ModelConfig,
    score: number,
    required: ModelCapability[],
  ): string {
    const matched = required.filter((c) => model.capabilities.includes(c))
    const missing = required.filter((c) => !model.capabilities.includes(c))

    let reason = `选择 ${model.name} (${model.modelId})：匹配能力 [${matched.join(", ")}]，覆盖率 ${(score * 100).toFixed(0)}%，路由顺序 ${model.priority}。`
    if (missing.length > 0) {
      reason += ` 未声明偏好能力 [${missing.join(", ")}]，已按可用模型降级而不中断任务。`
    }
    return reason
  }
}

function variantsFor(config: ModelConfig): ModelVariantConfig[] {
  if (config.models?.length) return config.models
  return config.modelId.split(",").map((modelId) => modelId.trim()).filter(Boolean).map((modelId, index) => ({
    id: index === 0 ? "default" : `model-${index + 1}`,
    name: config.modelId.includes(",") ? `${config.name} · ${modelId}` : config.name,
    modelId,
    capabilities: config.capabilities,
    priority: config.priority,
    costFactor: config.costFactor,
    enabled: true,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
  }))
}

function materialize(config: ModelConfig, variant: ModelVariantConfig): ModelConfig {
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

function hasEnabledModel(config: ModelConfig): boolean {
  return config.enabled && variantsFor(config).some((variant) => variant.enabled)
}

function isTransportCapability(capability: ModelCapability): boolean {
  return capability === "vision"
}

function capabilityCoverage(model: ModelConfig, required: ModelCapability[]): number {
  if (required.length === 0) return 1
  return required.filter((capability) => model.capabilities.includes(capability)).length / required.length
}
