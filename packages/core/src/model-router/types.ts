/**
 * 模型能力标签体系
 *
 * 每个模型可被标记为拥有以下一种或多种能力。
 * ModelRouter 根据任务类型自动匹配最优模型。
 */

/** 模型能力标签 */
export type ModelCapability = "vision" | "reasoning" | "coding" | "search" | "chat"

/** 一个供应商连接下的独立模型。 */
export interface ModelVariantConfig {
  id: string
  name: string
  modelId: string
  capabilities: ModelCapability[]
  priority: number
  costFactor: number
  enabled: boolean
  contextWindow: number
  maxOutputTokens: number
}

/** 模型配置 */
export interface ModelConfig {
  /** 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** Provider ID (openai / anthropic / openai-compatible) */
  provider: string
  /** 模型 ID (如 gpt-4o / claude-sonnet-4-5) */
  modelId: string
  /** API Key (或引用 credential store) */
  apiKey?: string
  /** API Base URL (openai-compatible 时必填) */
  baseUrl?: string
  /** 能力标签 */
  capabilities: ModelCapability[]
  /** 路由顺序 (1-100，1 为最高) */
  priority: number
  /** 成本系数 (相对值，1.0 为基准) */
  costFactor: number
  /** 是否启用 */
  enabled: boolean
  /** 最大 context window (tokens) */
  contextWindow: number
  /** 最大输出 tokens */
  maxOutputTokens: number
  /** 独立模型列表；缺失时由旧版顶层字段自动迁移。 */
  models?: ModelVariantConfig[]
}

/** 路由决策结果 */
export interface RoutingDecision {
  /** 选中的模型配置 */
  model: ModelConfig
  /** 匹配的能力标签 */
  matchedCapability: ModelCapability
  /** 能力偏好覆盖率 (0-1) */
  score: number
  /** 备选模型列表 (能力覆盖、路由顺序、成本的稳定顺序) */
  alternatives: ModelConfig[]
  /** 路由原因 */
  reason: string
}

/** Runtime-owned execution gate evaluated after administrative enablement. */
export interface ModelExecutionEligibility {
  executable: boolean
  code?: string
  reason?: string
}

export type ModelExecutionEligibilityPolicy = (model: ModelConfig) => ModelExecutionEligibility
