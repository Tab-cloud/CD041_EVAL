import type { ModelConfig } from "../model-router/types.ts"
import type { ModelRouter } from "../model-router/index.ts"
import type { ConversationObjectiveProposal } from "./conversation-objective.ts"
import type { ConversationObjectiveView } from "../store/conversation-objective.ts"
import type { ExecutionRunView } from "../store/execution-run.ts"
import { runToolModelInference } from "./tool-model-inference.ts"

export type ConversationTurnKind =
  | "new-objective"
  | "resume-objective"
  | "resume-plan"
  | "status-query"
  | "domain-query"
  | "conversation"

export type ConversationTurnMode = "execute" | "query" | "discuss" | "context"
export type ConversationExecutionTarget =
  | "open-objective"
  | "latest-run"
  | "latest-plan"
  | "new-objective"
  | "none"
export type ConversationQueryTarget = "run-status" | "domain" | "none"
export type ConversationContinuationMode = "control-only" | "refine"

export interface ConversationTurnIntent {
  kind: ConversationTurnKind
  confidence: number
  objectiveId?: string
  taskId?: string
  proposal?: ConversationObjectiveProposal
  /** Whether this turn only resumes execution or also changes the objective. */
  continuationMode?: ConversationContinuationMode
  /** Present only when advisory interpretation could not be grounded safely. */
  fallbackReason?: string
}

export interface ConversationTurnIntentInput {
  message: string
  recentAssistantMessages: Array<{ id: string; content: string }>
  openObjectives: ConversationObjectiveView[]
  latestResumable?: ExecutionRunView | null
  latestRelevant?: ExecutionRunView | null
  modelRouter: ModelRouter | null
  preferredModelId?: string
  sessionId: string
  /** Stable main-Agent root which owns this interpretation attempt. */
  rootRunId?: string
  abortSignal?: AbortSignal
}

const TURN_MODES = new Set<ConversationTurnMode>(["execute", "query", "discuss", "context"])
const EXECUTION_TARGETS = new Set<ConversationExecutionTarget>([
  "open-objective",
  "latest-run",
  "latest-plan",
  "new-objective",
  "none",
])
const QUERY_TARGETS = new Set<ConversationQueryTarget>(["run-status", "domain", "none"])

/**
 * Interpret a natural-language conversation turn using model semantics.
 *
 * The scheduler consumes only this structured result; it never maintains a
 * vocabulary of language-specific continuation/status keywords.
 */
export async function resolveConversationTurnIntent(
  input: ConversationTurnIntentInput,
): Promise<ConversationTurnIntent> {
  const candidates = resolveConversationIntentCandidates(input.modelRouter, input.preferredModelId)
  if (candidates.length === 0) {
    throw new Error("没有可用于会话意图解析的模型")
  }
  const objectiveIds = new Set(input.openObjectives.map((objective) => objective.id))
  const assistantMessageIds = new Set(input.recentAssistantMessages.map((message) => message.id))
  const resumableTaskId = input.latestResumable?.taskId
  const result = await runToolModelInference({
    modelRouter: input.modelRouter ?? undefined,
    preferredModelId: input.preferredModelId,
    modelFallbackEnabled: true,
    fallbackModelIds: candidates.slice(1).map((model) => model.id),
    abortSignal: input.abortSignal,
    runId: input.rootRunId ?? `intent-${input.sessionId}`,
    sessionId: input.sessionId,
    agentId: "main-agent",
    executionSegment: 0,
    executionStep: 0,
  }, {
    capability: "reasoning",
    candidateModels: candidates,
    maxAttempts: Math.min(3, candidates.length),
    maxOutputTokens: 256,
    thinkingEnabled: false,
    operation: "conversation-intent",
    system: [
      "你是主 Agent 的会话回合意图解析器。",
      "根据当前输入和持久会话状态判断用户在做什么，不执行任务，不回答用户问题。",
      "必须理解任意自然语言、拼音、转写、口语、省略和轻微拼写错误；禁止依赖关键词表。",
      "只输出一个 JSON 对象，不要 Markdown、解释或思考过程。",
      'mode 只能是 "execute"、"query"、"discuss"、"context"。',
      'executionTarget 只能是 "open-objective"、"latest-run"、"latest-plan"、"new-objective"、"none"。',
      'queryTarget 只能是 "run-status"、"domain"、"none"。',
      "execute 表示用户明确要求开始、继续、重试或完成工作；query 表示用户要求检查、解释或回答。",
      "query/run-status 只表示询问当前 Agent 执行队列、运行进度或某次执行是否仍在运行。",
      "query/domain 表示询问产品、代码、功能、算法、文档或工程本身是否完整以及包含什么；即使句子中有“完成了吗”，也不是续接旧任务。",
      "discuss 表示非执行性的方案讨论；context 表示补充上下文或回答主 Agent 的问题。",
      "输出介质决定是否执行：仅在聊天中给出方案、设计、计算、建议、步骤或交付物清单，不会改变工作区或外部状态，必须归为 query/domain 或 discuss；只有用户要求把内容保存、创建或修改到会话外的真实产物时才是 execute/new-objective。",
      "execute/open-objective 才能续接尚未验收的目标，并优先返回给定 objectiveId。",
      "execute/latest-run 表示续接最新可恢复运行并返回 taskId；execute/latest-plan 表示执行已批准计划。",
      "execute/new-objective 表示启动新的执行目标。",
      'continuationMode 只能是 "control-only"、"refine"、"none"。',
      "当 executionTarget 是 open-objective 或 latest-run 时，continuationMode 必须给出：currentInput 只表达继续、重试或确认而不改变目标时为 control-only；新增范围、约束、输出深度、方法、格式或交付物时为 refine。",
      "其他 executionTarget 的 continuationMode 必须为 none。这个判断必须基于整句语义，不得依赖关键词表。",
      "字段必须满足：execute 时 queryTarget=none 且 executionTarget!=none；query 时 executionTarget=none 且 queryTarget!=none；discuss/context 时两个 target 都为 none。",
      "仅当没有 objectiveId/taskId 且历史主 Agent 回复中存在明确工作清单时，才返回 proposal。",
      "proposal 必须包含对应回复的 sourceMessageId 和逐项 tasks；不得从用户本轮短句臆造任务。",
      '格式：{"mode":"...","executionTarget":"...","queryTarget":"...","continuationMode":"control-only|refine|none","confidence":0到1,"objectiveId":"可选","taskId":"可选","proposal":{"sourceMessageId":"可选","tasks":["可选"]}}',
    ].join("\n"),
    messages: () => [{
      role: "user",
      content: JSON.stringify({
        currentInput: input.message,
        recentMainAgentDeliveries: input.recentAssistantMessages.map((message) => ({
          id: message.id,
          content: message.content.slice(0, 2_000),
        })),
        openObjectives: input.openObjectives.map((objective) => ({
          id: objective.id,
          taskCount: objective.taskCount,
          tasks: objective.tasks,
          state: objective.state,
        })),
        latestResumable: input.latestResumable ? projectExecution(input.latestResumable) : null,
        latestRelevant: input.latestRelevant ? projectExecution(input.latestRelevant) : null,
      }),
    }],
  })

  return reconcileConversationTurnIntent(parseConversationTurnIntent(result.text), {
    objectiveIds,
    openObjectives: input.openObjectives,
    assistantMessageIds,
    resumableTaskId,
  })
}

/**
 * Ground model-authored conversation advice in durable runtime state.
 *
 * A semantic helper may suggest that a turn resumes earlier work, but only the
 * runtime can prove that such work still exists. An ungrounded suggestion must
 * never become an admission failure: it degrades to an ordinary user turn so
 * the main Agent still receives the request and the full conversation history.
 */
export function reconcileConversationTurnIntent(
  intent: ConversationTurnIntent,
  state: {
    objectiveIds: ReadonlySet<string>
    openObjectives: ConversationObjectiveView[]
    assistantMessageIds: ReadonlySet<string>
    resumableTaskId?: string
  },
): ConversationTurnIntent {
  if (intent.kind !== "resume-objective") return intent

  const objectiveId = intent.objectiveId && state.objectiveIds.has(intent.objectiveId)
    ? intent.objectiveId
    : state.openObjectives.length === 1 ? state.openObjectives[0]!.id : undefined
  const taskId = intent.taskId === state.resumableTaskId
    ? intent.taskId
    : !objectiveId ? state.resumableTaskId : undefined
  const proposal = intent.proposal
    && intent.proposal.sourceMessageId
    && state.assistantMessageIds.has(intent.proposal.sourceMessageId)
    ? intent.proposal
    : undefined

  if (!objectiveId && !taskId && !proposal) {
    return fallbackConversationTurnIntent(
      "模型建议续接，但当前会话没有可绑定的未完成目标、可恢复运行或已确认任务清单",
    )
  }
  return { ...intent, objectiveId, taskId, proposal }
}

/**
 * Non-authoritative semantic helpers may improve routing but cannot veto a
 * user turn. Explicit cancellation/abort remains outside this fallback.
 */
export function fallbackConversationTurnIntent(cause: unknown): ConversationTurnIntent {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return {
    kind: "new-objective",
    confidence: 0,
    fallbackReason: reason.slice(0, 500),
  }
}

export function parseConversationTurnIntent(text: string): ConversationTurnIntent {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const match = source.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("会话意图模型没有返回 JSON 对象")
  let value: unknown
  try {
    value = JSON.parse(match[0])
  } catch {
    throw new Error("会话意图模型返回了无效 JSON")
  }
  if (!value || typeof value !== "object") throw new Error("会话意图结果不是对象")
  const record = value as Record<string, unknown>
  const mode = typeof record.mode === "string" && TURN_MODES.has(record.mode as ConversationTurnMode)
    ? record.mode as ConversationTurnMode
    : null
  const executionTarget = typeof record.executionTarget === "string"
    && EXECUTION_TARGETS.has(record.executionTarget as ConversationExecutionTarget)
    ? record.executionTarget as ConversationExecutionTarget
    : null
  const queryTarget = typeof record.queryTarget === "string"
    && QUERY_TARGETS.has(record.queryTarget as ConversationQueryTarget)
    ? record.queryTarget as ConversationQueryTarget
    : null
  const continuationMode = record.continuationMode === "control-only" || record.continuationMode === "refine"
    ? record.continuationMode
    : record.continuationMode === "none" ? undefined : null
  if (!mode || !executionTarget || !queryTarget || continuationMode === null) {
    throw new Error("会话意图模型返回了未知语义字段")
  }
  validateSemanticIntent(mode, executionTarget, queryTarget)
  const isContinuation = mode === "execute"
    && (executionTarget === "open-objective" || executionTarget === "latest-run")
  if (isContinuation !== Boolean(continuationMode)) {
    throw new Error("会话续接意图缺少目标变更模式")
  }
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : 0
  if (confidence < 0.6) throw new Error("会话意图置信度不足")
  const kind = deriveTurnKind(mode, executionTarget, queryTarget)
  return {
    kind,
    confidence,
    objectiveId: mode === "execute" && executionTarget === "open-objective"
      && typeof record.objectiveId === "string" ? record.objectiveId : undefined,
    taskId: mode === "execute" && executionTarget === "latest-run"
      && typeof record.taskId === "string" ? record.taskId : undefined,
    proposal: mode === "execute" ? normalizeProposal(record.proposal) : undefined,
    continuationMode,
  }
}

function validateSemanticIntent(
  mode: ConversationTurnMode,
  executionTarget: ConversationExecutionTarget,
  queryTarget: ConversationQueryTarget,
): void {
  if (mode === "execute") {
    if (executionTarget === "none" || queryTarget !== "none") {
      throw new Error("会话执行意图字段相互矛盾")
    }
    return
  }
  if (mode === "query") {
    if (executionTarget !== "none" || queryTarget === "none") {
      throw new Error("会话查询意图字段相互矛盾")
    }
    return
  }
  if (executionTarget !== "none" || queryTarget !== "none") {
    throw new Error("会话讨论意图字段相互矛盾")
  }
}

function deriveTurnKind(
  mode: ConversationTurnMode,
  executionTarget: ConversationExecutionTarget,
  queryTarget: ConversationQueryTarget,
): ConversationTurnKind {
  if (mode === "query") {
    return queryTarget === "run-status" ? "status-query" : "domain-query"
  }
  if (mode !== "execute") return "conversation"
  if (executionTarget === "open-objective" || executionTarget === "latest-run") return "resume-objective"
  if (executionTarget === "latest-plan") return "resume-plan"
  return "new-objective"
}

export function resolveConversationIntentCandidates(
  router: ModelRouter | null,
  preferredModelId?: string,
): ModelConfig[] {
  if (!router) return []
  const preferred = preferredModelId ? router.getModel(preferredModelId) : undefined
  const ordered = [
    ...(preferred ? [preferred] : []),
    ...router.list.filter((model) => model.capabilities.includes("reasoning") || model.capabilities.includes("chat")),
  ]
  const identities = new Set<string>()
  const result: ModelConfig[] = []
  for (const model of ordered) {
    const identity = `${model.provider}\u0000${model.baseUrl ?? ""}\u0000${model.modelId}`
    if (identities.has(identity)) continue
    identities.add(identity)
    result.push(model)
  }
  return result
}

function projectExecution(run: ExecutionRunView) {
  return {
    taskId: run.taskId,
    state: run.snapshot.state,
    stopReason: run.snapshot.stopReason,
    runtimeObjectiveAccepted: run.snapshot.runtimeObjectiveAccepted,
    todos: run.snapshot.todos.map((todo) => ({
      content: todo.content,
      status: todo.status,
    })),
  }
}

function normalizeProposal(value: unknown): ConversationObjectiveProposal | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.sourceMessageId !== "string" || !record.sourceMessageId.trim()) return undefined
  if (!Array.isArray(record.tasks)) return undefined
  const tasks = record.tasks
    .filter((task): task is string => typeof task === "string")
    .map((task) => task.trim())
    .filter(Boolean)
    .slice(0, 50)
  if (tasks.length === 0 || tasks.some((task) => task.length > 1_000)) return undefined
  return {
    sourceMessageId: record.sourceMessageId,
    content: [
      "主 Agent 已确认的待办清单：",
      ...tasks.map((task, index) => `${index + 1}. ${task}`),
    ].join("\n"),
    taskCount: tasks.length,
    tasks,
  }
}
