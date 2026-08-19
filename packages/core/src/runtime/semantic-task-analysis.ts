import type { AgentDefinition } from "../agent/types.ts"
import type { ModelConfig } from "../model-router/types.ts"
import type { ModelRouter } from "../model-router/index.ts"
import type { ToolEffect } from "../tool/types.ts"
import type { ExecutionScope } from "./tool-policy.ts"
import type { ConversationTurnKind } from "./conversation-turn-intent.ts"
import {
  OBJECTIVE_GOAL_TYPES,
  OBJECTIVE_TOOL_EFFECTS,
  type ObjectiveGoalType,
  normalizeStructuredObjectiveIntent,
  type StructuredObjectiveIntent,
} from "./objective-compiler.ts"
import { runToolModelInference } from "./tool-model-inference.ts"

export type SemanticTaskComplexity = "simple" | "compound" | "complex"

export interface SemanticTaskAnalysis extends StructuredObjectiveIntent {
  complexity: SemanticTaskComplexity
  source: "model" | "runtime-fallback"
  fallbackReason?: string
}

export interface SemanticTaskAnalysisInput {
  message: string
  scope: ExecutionScope
  turnKind?: ConversationTurnKind
  resources?: SemanticTaskResource[]
  agents: AgentDefinition[]
  modelRouter: ModelRouter | null
  preferredModelId?: string
  fallbackModelIds?: string[]
  modelFallbackEnabled?: boolean
  sessionId: string
  runId?: string
  abortSignal?: AbortSignal
  onAgentEvent?: (event: any) => void
}

export interface SemanticTaskResource {
  name: string
  mime: string
  kind: "image" | "text" | "binary"
}

const COMPLEXITIES = new Set<SemanticTaskComplexity>(["simple", "compound", "complex"])

export class SemanticTaskAnalysisUnavailableError extends Error {
  readonly code = "semantic-task-analysis-unavailable"
  readonly causeMessage: string

  constructor(cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause)
    super(`语义任务分析不可用：${causeMessage}`)
    this.name = "SemanticTaskAnalysisUnavailableError"
    this.causeMessage = causeMessage.slice(0, 500)
  }
}

/**
 * Resolve task meaning once at the request boundary.
 *
 * Language understanding belongs to the model. The runtime validates the
 * returned protocol and reports a typed helper failure to the routing layer.
 * Routing may use a permission-neutral general fallback; tool authority still
 * comes only from execution scope, static Agent grants and system policy.
 */
export async function analyzeSemanticTask(
  input: SemanticTaskAnalysisInput,
): Promise<SemanticTaskAnalysis> {
  const assignableAgents = input.agents.filter((agent) => agent.mode !== "primary")
  const knownAgentIds = new Set(assignableAgents.map((agent) => agent.id))

  const candidates = resolveSemanticAnalysisCandidates(
    input.modelRouter,
    input.preferredModelId,
    input.fallbackModelIds,
    input.modelFallbackEnabled,
  )
  if (candidates.length === 0) {
    throw new SemanticTaskAnalysisUnavailableError("没有配置可用于语义任务分析的模型")
  }

  try {
    const result = await runToolModelInference({
      modelRouter: input.modelRouter ?? undefined,
      preferredModelId: input.preferredModelId,
      fallbackModelIds: candidates.slice(1).map((model) => model.id),
      modelFallbackEnabled: input.modelFallbackEnabled ?? true,
      abortSignal: input.abortSignal,
      runId: input.runId ?? `semantic-${input.sessionId}`,
      sessionId: input.sessionId,
      agentId: "main-agent",
      executionSegment: 0,
      executionStep: 0,
      onAgentEvent: input.onAgentEvent,
    }, {
      capability: "reasoning",
      candidateModels: candidates,
      maxAttempts: 3,
      maxProtocolRepairAttempts: 2,
      maxOutputTokens: 2_048,
      thinkingEnabled: false,
      operation: "semantic-task-analysis",
      system: buildSemanticAnalysisSystemPrompt(assignableAgents),
      validateOutput: (text) => {
        parseSemanticTaskAnalysis(text, knownAgentIds)
      },
      messages: (_model, protocolFeedback) => [{
        role: "user",
        content: JSON.stringify({
          userRequest: input.message,
          executionScope: input.scope,
          conversationTurnKind: input.turnKind,
          availableResources: normalizeSemanticTaskResources(input.resources),
          ...(protocolFeedback ? {
            protocolRepair: {
              rejectedBecause: protocolFeedback,
              instruction: "修正结构化路由协议并重新输出完整 JSON；不得删除用户目标或增加协议外字段。",
            },
          } : {}),
        }),
      }],
    })
    return {
      ...bindSemanticTaskResources(
        parseSemanticTaskAnalysis(result.text, knownAgentIds),
        input.resources,
      ),
      source: "model",
    }
  } catch (error) {
    if (input.abortSignal?.aborted) throw error
    throw new SemanticTaskAnalysisUnavailableError(error)
  }
}

/**
 * Bind targetless inspection requirements to resources admitted with this
 * exact user turn. The semantic model owns intent, while the runtime owns
 * resource identity and evidence realizability.
 *
 * `source-inspection` is valid only for source artifacts. A targetless source
 * requirement attached to a PDF/Office/text document is structurally
 * unrealizable, so it is normalized to workspace inspection before the
 * objective contract is compiled.
 */
export function bindSemanticTaskResources(
  input: Omit<SemanticTaskAnalysis, "source">,
  resources: SemanticTaskResource[] | undefined,
): Omit<SemanticTaskAnalysis, "source"> {
  const normalizedResources = normalizeSemanticTaskResources(resources)
  if (normalizedResources.length === 0) return input
  const resourceNames = normalizedResources.map((resource) => resource.name)
  const sourceNames = new Set(normalizedResources
    .filter((resource) => isSourceResource(resource))
    .map((resource) => resource.name))
  const acceptanceRequirements = input.acceptanceRequirements.map((requirement) => {
    const inspection = requirement.anyOf.some((kind) => [
      "workspace-inspection",
      "source-inspection",
      "datasheet-inspection",
      "schematic-inspection",
    ].includes(kind))
    if (!inspection) return requirement
    const targetPatterns = requirement.targetPatterns.length > 0
      ? requirement.targetPatterns
      : resourceNames
    const targetsOnlyNonSourceResources = targetPatterns.length > 0
      && targetPatterns.every((target) => !sourceNames.has(normalizeResourceName(target)))
    if (!requirement.anyOf.includes("source-inspection") || !targetsOnlyNonSourceResources) {
      return { ...requirement, targetPatterns }
    }
    const anyOf = [...new Set(requirement.anyOf.map((kind) =>
      kind === "source-inspection" ? "workspace-inspection" as const : kind))]
    return {
      ...requirement,
      verifier: "workspace-inspection" as const,
      anyOf,
      targetPatterns,
    }
  })
  const normalized = normalizeStructuredObjectiveIntent({
    ...input,
    acceptanceRequirements,
  })
  return { ...normalized, complexity: input.complexity }
}

export function parseSemanticTaskAnalysis(
  text: string,
  knownAgentIds: ReadonlySet<string>,
): Omit<SemanticTaskAnalysis, "source" | "fallbackReason"> {
  const record = parseStrictObject(text, "语义任务分析")
  assertExactKeys(record, [
    "goalType",
    "complexity",
    "requiredEffects",
    "candidateAgentIds",
    "requiresPlanning",
  ], "语义任务分析")

  if (typeof record.complexity !== "string"
    || !COMPLEXITIES.has(record.complexity as SemanticTaskComplexity)) {
    throw new Error("语义任务分析 complexity 无效")
  }
  if (typeof record.requiresPlanning !== "boolean") {
    throw new Error("语义任务分析 requiresPlanning 必须是布尔值")
  }
  if (record.complexity === "complex" && record.requiresPlanning !== true) {
    throw new Error("complex 任务必须进入结构化规划")
  }

  const candidateAgentIds = parseCandidateAgents(record.candidateAgentIds, knownAgentIds)
  // The semantic model classifies the request; it does not author the
  // execution acceptance contract. Runtime policy derives every evidence
  // floor from admitted effects and later binds it to real resources.
  const normalized = normalizeStructuredObjectiveIntent({
    goalType: record.goalType as ObjectiveGoalType,
    requiredEffects: record.requiredEffects as ToolEffect[],
    candidateAgentIds,
    requiresPlanning: record.requiresPlanning,
    acceptanceRequirements: [],
  })
  return {
    ...normalized,
    complexity: record.complexity as SemanticTaskComplexity,
  }
}

/** Revalidate an in-memory protocol before it crosses into runtime routing. */
export function validateSemanticTaskAnalysis(
  input: SemanticTaskAnalysis,
  knownAgentIds: ReadonlySet<string>,
): SemanticTaskAnalysis {
  if (input.source !== "model" && input.source !== "runtime-fallback") {
    throw new SemanticTaskAnalysisUnavailableError("语义任务分析没有可信运行时来源")
  }
  if (!COMPLEXITIES.has(input.complexity)) throw new Error("语义任务分析 complexity 无效")
  if (input.complexity === "complex" && input.requiresPlanning !== true) {
    throw new Error("complex 任务必须进入结构化规划")
  }
  const candidateAgentIds = parseCandidateAgents(input.candidateAgentIds, knownAgentIds)
  return {
    ...normalizeStructuredObjectiveIntent({
      ...input,
      candidateAgentIds,
    }),
    complexity: input.complexity,
    source: input.source,
    fallbackReason: input.fallbackReason,
  }
}

/**
 * Safe advisory fallback when the semantic helper is unavailable.
 *
 * The main Agent still runs under the user-selected execution scope, static
 * Agent permissions and tool policy. Falling back to the general role grants
 * no authority; it merely avoids preventing the conversation model from using
 * capabilities it already owns.
 */
export function fallbackSemanticTaskAnalysis(cause: unknown): SemanticTaskAnalysis {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return {
    goalType: "general",
    complexity: "simple",
    requiredEffects: [],
    candidateAgentIds: ["general"],
    requiresPlanning: false,
    acceptanceRequirements: [],
    source: "runtime-fallback",
    fallbackReason: reason.slice(0, 500),
  }
}

export function resolveSemanticAnalysisCandidates(
  router: ModelRouter | null,
  preferredModelId?: string,
  fallbackModelIds: string[] = [],
  fallbackEnabled = true,
): ModelConfig[] {
  if (!router) return []
  const preferred = preferredModelId ? router.getModel(preferredModelId) : undefined
  const configured = fallbackModelIds
    .map((id) => router.getModel(id))
    .filter((model): model is ModelConfig => Boolean(model))
  const capable = router.list.filter((model) =>
    model.capabilities.includes("reasoning") || model.capabilities.includes("chat"))
  const ordered = [
    ...(preferred && capable.some((model) => model.id === preferred.id) ? [preferred] : []),
    ...configured,
    ...capable,
  ]
  const identities = new Set<string>()
  const result: ModelConfig[] = []
  for (const model of ordered) {
    const identity = `${model.provider}\u0000${model.baseUrl ?? ""}\u0000${model.modelId}`
    if (identities.has(identity)) continue
    identities.add(identity)
    result.push(model)
    if (!fallbackEnabled) break
  }
  return result
}

function buildSemanticAnalysisSystemPrompt(agents: AgentDefinition[]): string {
  return [
    "你是每个会话唯一主 Agent 的结构化任务语义分析器。",
    "只理解和分类，不执行任务，也不直接回复用户。",
    "必须理解自然语言的同义改写、拼音、口语、省略、错别字和跨领域组合；禁止使用关键词表或正则词典分类。",
    "只输出一个 JSON 对象，不要 Markdown、解释、前后缀或思考过程。",
    `goalType 只能是：${OBJECTIVE_GOAL_TYPES.join(", ")}。`,
    'complexity 只能是 "simple"、"compound"、"complex"；complex 必须 requiresPlanning=true。',
    `requiredEffects 只能包含：${OBJECTIVE_TOOL_EFFECTS.join(", ")}；它表示交付当前目标前实际必须发生的工具效果，不是主题标签、可能用到的能力或授权。`,
    "requiredEffects 必须最小化：仅提供解释、评估、方案或建议时，不得因为主题涉及硬件就声明 physical hardware 操作，也不得在用户未要求产物变更时声明 workspace-write。",
    "聊天正文中的设计章节、BOM、公式、验证计划或交付物清单仍是回答内容，不是工作区产物。只有用户明确要求在会话外保存、创建或修改真实文件/工程时，才声明 workspace-write 和对应文件验收；不得自行发明目录、文件名或落盘要求。",
    "goalType=plan 表示交付规划内容；在非 plan-mode 下，如果没有用户随本回合提供的资源，它本身不要求 plan 工具、workspace-write 或 delegation。",
    "conversationTurnKind 是独立会话意图边界：domain-query/conversation 只能回答、解释或讨论，不得转化成实施、编译、测试、写文件、硬件操作或多 Agent 项目。",
    "domain-query/conversation 的 requiredEffects 只能包含 workspace-read、network，requiresPlanning 必须为 false。",
    "delegation 由运行时根据 requiresPlanning 自动加入；不要在 requiredEffects 中重复声明。可能需要澄清不等于 user-interaction，只有目标确实无法在现有信息下交付时才声明。",
    "candidateAgentIds 按推荐执行顺序给出 1 到 8 个已注册子 Agent；不得返回 main-agent 或未知 ID。",
    "requiresPlanning 表示目标需要依赖图、多个可独立验收子任务或跨域协调；普通单步执行不得因为措辞较长而强制规划。",
    "验收证据、校验器和目标资源绑定由运行时根据已准入效果和真实附件生成；不得输出 acceptanceRequirements、verifier、anyOf 或 targetPatterns。",
    "requiredEffects 对应的机械性最低验收由运行时不可变策略自动补齐：workspace-write 至少加入 mutation 与独立工作区检查，process 至少加入进程验证，hardware 至少加入硬件观测，network 至少加入外部研究。模型不得为了规避验收而少报 requiredEffects。",
    "运行时只叠加规划阶段等真实状态下界，并根据实际工具调用动态治理；不得假设运行时会从用户原文猜测遗漏效果。",
    '严格格式：{"goalType":"...","complexity":"...","requiredEffects":["..."],"candidateAgentIds":["..."],"requiresPlanning":false}',
    "可用子 Agent：",
    JSON.stringify(agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      tools: agent.tools,
      capabilities: agent.requiredCapabilities,
    }))),
  ].join("\n")
}

function normalizeSemanticTaskResources(
  resources: SemanticTaskResource[] | undefined,
): SemanticTaskResource[] {
  if (!Array.isArray(resources)) return []
  const seen = new Set<string>()
  return resources.flatMap((resource) => {
    if (!resource || typeof resource.name !== "string") return []
    const name = normalizeResourceName(resource.name)
    if (!name || seen.has(name)) return []
    seen.add(name)
    return [{
      name,
      mime: typeof resource.mime === "string" ? resource.mime.slice(0, 100) : "",
      kind: resource.kind === "image" || resource.kind === "binary" ? resource.kind : "text",
    } satisfies SemanticTaskResource]
  }).slice(0, 10)
}

function normalizeResourceName(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^.*\//, "").toLowerCase().slice(0, 255)
}

function isSourceResource(resource: SemanticTaskResource): boolean {
  return /\.(?:c|h|cc|cpp|cxx|hpp|s|asm|ld|mk|rs|go|py|java|kt|swift|ts|tsx|js|jsx|vue|svelte)$/i
    .test(resource.name)
}

function parseCandidateAgents(value: unknown, knownAgentIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error("candidateAgentIds 必须包含 1 到 8 个 Agent")
  }
  const result: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error("candidateAgentIds 包含无效 ID")
    }
    const id = candidate.trim()
    if (id === "main-agent" || !knownAgentIds.has(id)) {
      throw new Error(`candidateAgentIds 包含未知或不可委派 Agent: ${id}`)
    }
    if (!result.includes(id)) result.push(id)
  }
  return result
}

function parseStrictObject(text: string, label: string): Record<string, unknown> {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const match = source.match(/\{[\s\S]*\}/)
  if (!match || match[0] !== source) throw new Error(`${label}必须只返回一个 JSON 对象`)
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error(`${label}返回了无效 JSON`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}结果不是对象`)
  }
  return parsed as Record<string, unknown>
}

function assertExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys)
  const actual = Object.keys(record)
  const unknown = actual.filter((key) => !allowed.has(key))
  const missing = keys.filter((key) => !Object.hasOwn(record, key))
  if (unknown.length || missing.length) {
    throw new Error(`${label}字段不符合协议：缺少 [${missing.join(", ")}]，未知 [${unknown.join(", ")}]`)
  }
}
