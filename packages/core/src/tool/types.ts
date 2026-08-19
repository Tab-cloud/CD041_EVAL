/** 工具执行上下文 */
export interface SearchRuntimeConfig {
  provider: "auto" | "duckduckgo" | "bing" | "google-news"
  timeoutMs: number
  maxResults: number
}

export type AgentActivityState =
  | "queued" | "thinking" | "reading" | "editing" | "executing"
  | "collaborating" | "waiting-human" | "resting" | "completed" | "failed"

export interface AgentActivityEvent {
  runId: string
  parentRunId?: string
  sessionId: string
  agentId: string
  agentName?: string
  state: AgentActivityState
  activity: string
  toolName?: string
  timestamp: number
}

export interface ToolContext {
  /** Stable execution identity. Conversation history remains keyed by sessionId. */
  runId?: string
  parentRunId?: string
  runType?: "root" | "subagent" | "workflow-node"
  /** Root-run continuation segment and current Agent round for model-call correlation. */
  executionSegment?: number
  executionStep?: number
  /** Stable model-issued invocation identity used for external idempotency keys. */
  toolCallId?: string
  sessionId: string
  /** Permission state belongs to the root run and is inherited by child Agents. */
  permissionContextId?: string
  agentId: string
  workingDir: string
  /** 子Agent委派时需要 */
  agentRegistry?: import("../agent/registry").AgentRegistry
  toolRegistry?: import("./registry").ToolRegistry
  modelRouter?: import("../model-router/index").ModelRouter
  /** 子 Agent 委派深度（防递归失控，由 task 工具递增） */
  __depth?: number
  /**
   * Runtime-owned atomic delegation group. Models cannot provide this value.
   * Individual child calls skip parent gating because the group owns the
   * single suspend/resume boundary.
   */
  delegationGroup?: {
    id: string
    parentGateOwned: true
    onChildScheduled: (runId: string) => void
  }
  /** 当前用户选择的工具执行范围。 */
  scope?: "full-access" | "auto-edit" | "plan-mode" | "confirm-changes"
  /** 客户端断开或用户取消时中止模型和工具。 */
  abortSignal?: AbortSignal
  /** 系统级工具策略，子 Agent 委派时继续继承。 */
  toolPolicy?: import("../runtime/tool-policy").RuntimeToolPolicy
  /** Parent-issued capability; delegated tools cannot access resources outside it. */
  resourceClaims?: import("../runtime/run-contract").ResourceClaims
  /**
   * Frozen executable plan owned by the root runtime. Tool parameters may
   * reference it, but can never replace its DAG or node contracts.
   */
  activePlan?: import("../runtime/executable-plan").ExecutablePlan
  /** 搜索提供商和请求边界。 */
  searchConfig?: SearchRuntimeConfig
  /** 模型调用失败时是否允许切换到备用模型。 */
  modelFallbackEnabled?: boolean
  /** 当前轮实际成功的模型；子 Agent 委派时继承，避免重新路由到其他供应商。 */
  preferredModelId?: string
  /** 用户配置的 Agent 专属路由；委派时按子 Agent 身份重新选择。 */
  agentModelRoutes?: Record<string, { primaryModelId: string; fallbackModelIds: string[] }>
  /** Absolute deadline owned by this run; delegated children receive a shorter lease. */
  executionDeadline?: number
  /** Hierarchical lease policy shared by the complete execution tree. */
  executionBudget?: import("../runtime/execution-budget").ExecutionBudgetPolicy
  /** Root scheduler gate inherited by delegated Agents during approval waits. */
  executionGate?: { suspendForApproval: (reason: string) => void; resumeAfterApproval: () => Promise<void> }
  /**
   * One-shot answer injected by the runtime only after a real modal response.
   * Tools may consume it while retrying the exact suspended invocation.
   */
  resolvedUserInteraction?: {
    toolCallId: string
    type: "target-confirmation" | "target-family-confirmation"
    answer: string
  }
  /** 用户为当前 Agent 配置的备用模型顺序。 */
  fallbackModelIds?: string[]
  /** 当前配置禁用的 Skill 名称。 */
  disabledSkillIds?: string[]
  /** 实时流式输出回调：工具执行中逐行推送到底部面板 */
  streamOutput?: (target: "terminal" | "build" | "serial", line: string, type: "stdout" | "stderr" | "info") => void
  /** 数字员工办公室活动流；子 Agent 通过父 Agent 的 SSE 通道汇报状态。 */
  onAgentActivity?: (event: AgentActivityEvent) => void
  /** 子 Agent 的审批与执行事件桥接到父 Agent 的 SSE 通道。 */
  onAgentEvent?: (event: unknown) => void
  /**
   * Parent-owned child interaction broker. A delegated Agent must await this
   * callback instead of writing to the public approval/question managers.
   */
  onSubAgentInteraction?: (request: {
    type: "approval-request" | "question-request"
    payload: unknown
    requiresMainAgentReview: true
    visibility: "internal"
  }) => Promise<
    | { status: "answered"; answer: string }
    | { status: "approved" | "denied" | "expired" | "cancelled" }
  >
  /** Per-run proof of inspected project assets, enforced before mutations. */
  evidence?: import("./execution-evidence").ExecutionEvidenceLedger
}

export type ToolOutcomeStatus = "succeeded" | "failed" | "cancelled" | "timed-out"

/**
 * Runtime-facing result metadata. The Agent loop consumes this structure instead
 * of reverse engineering control flow from human-readable tool output.
 */
export interface ToolOutcome {
  status: ToolOutcomeStatus
  category: "command" | "build" | "permission" | "evidence" | "generic"
  summary: string
  /**
   * Evidence issued by trusted tool/runtime code after the operation has
   * actually succeeded. Model-authored input fields are never evidence.
   */
  evidence?: ToolEvidenceAttestation[]
  /** Stable identity used by the repeated-failure guard. */
  fingerprint?: string
  exitCode?: number
  /** Machine-readable diagnosis used by the execution controller and model. */
  diagnostic?: ToolDiagnostic
}

export interface ToolEvidenceAttestation {
  kind:
    | "plan-submission"
    | "build-success"
    | "test-success"
    | "regression-test-success"
    | "stress-test-success"
    | "schematic-inspection"
    | "datasheet-inspection"
    | "source-inspection"
    | "workspace-inspection"
    | "external-research"
    | "workspace-mutation"
    | "process-verification"
    | "hardware-observation"
  targets: string[]
  /** Identifies the controlled adapter which validated the operation. */
  producer: string
}

export interface ToolDiagnostic {
  kind: string
  evidence: string[]
  nextActions: string[]
  /**
   * Runtime control disposition for this exact domain failure.
   *
   * `continue` keeps the normal model loop, `recover` enters bounded
   * structured recovery, and `terminal` means no safe autonomous recovery
   * exists. Omission preserves the conservative legacy default of `recover`.
   */
  failureDisposition?: "continue" | "recover" | "terminal"
  /**
   * Whether another safe internal strategy can reasonably recover this
   * operation. Omission means the runtime planner may still propose a bounded
   * generic strategy from the tool execution contract.
   */
  retryable?: boolean
  /**
   * A genuine external dependency. This is evidence for the blocker arbiter,
   * not permission for a model to mark arbitrary work as blocked.
   */
  externalBlocker?: {
    kind: "user-decision" | "permission" | "hardware" | "external-service"
    reason: string
  }
  /**
   * Alternative machine-readable strategies authored by the failing domain
   * tool. Runtime selection is based only on these contracts and tool effects;
   * nextActions prose is never parsed for control flow.
   */
  recoveryCandidates?: ToolRecoveryCandidate[]
  /**
   * Whether the domain tool's recovery candidates are suggestions or the
   * complete safe recovery set for this fault. A closed set must never fall
   * back to generic recovery or phase-driven re-entry after every candidate
   * has failed.
   */
  recoveryCandidateSet?: "open" | "closed"
  symbols?: string[]
  missingPath?: string
}

export interface ToolRecoveryCandidate {
  id: string
  summary: string
  steps: Array<{
    instruction: string
    tools?: string[]
    effects?: ToolEffect[]
  }>
}

/** 工具执行结果 */
export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  truncated?: boolean
  outcome?: ToolOutcome
}

export type ToolEffect =
  | "workspace-read"
  | "workspace-write"
  | "process"
  | "network"
  | "hardware"
  | "user-interaction"
  | "delegation"

export interface ToolExecutionContract {
  /**
   * User-authorized, externally observable effect domains. Infrastructure used
   * to run the Agent itself (for example an LLM request) belongs in
   * runtimeDependencies and must not widen or hide a domain tool.
   * Generic executors must still declare the superset of domain effects.
   */
  effects: readonly ToolEffect[]
  /**
   * Effects exercised by every invocation. When omitted, the full `effects`
   * set is treated as mandatory. Generic tools may use this minimum at model
   * visibility time while concrete calls are still checked against the
   * runtime-resolved effect set.
   */
  alwaysEffects?: readonly ToolEffect[]
  /** Runtime infrastructure needed by the implementation, not user-domain effects. */
  runtimeDependencies?: {
    modelCapabilities?: readonly import("../model-router/types.ts").ModelCapability[]
  }
  /** Determines whether an interrupted invocation may be replayed automatically. */
  idempotency: "read-only" | "idempotent" | "non-idempotent" | "unknown"
  /** How cancellation reaches the actual operation. */
  cancellation: "cooperative" | "process-tree" | "unsupported"
  /**
   * Semantic contribution to the objective loop. This is deliberately
   * separate from security effects: a build tool may conservatively have
   * workspace-write capability while its progress role is verification.
   */
  progress: {
    role: "control" | "inspection" | "mutation" | "verification" | "delegation" | "dynamic"
    /** Input fields that identify the workspace targets affected or checked. */
    targetParameters?: readonly string[]
    /** Whether successful verification closes all pending mutation targets. */
    verificationScope?: "targeted" | "global"
  }
}

/** 工具定义 */
export interface ToolDefinition {
  /** 工具名称 */
  name: string
  /** 描述 (给 LLM 看的) */
  description: string
  /** 权限动作名 */
  permission: string
  /** JSON Schema 参数定义 */
  parameters: Record<string, unknown>
  /** 执行函数 */
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
  /** Runtime-enforced capability and lifecycle contract. */
  contract: ToolExecutionContract
  /**
   * Trusted built-in refinement for one concrete invocation. The returned
   * effects may only narrow the conservative `contract.effects` superset.
   * Invalid or throwing refinements fail closed to the full superset.
   */
  resolveAuthorizationEffects?: (input: Record<string, unknown>) => readonly ToolEffect[]
  /** 管理中心展示来源。 */
  source?: "builtin" | "mcp" | "plugin"
  /** 管理中心展示分类。 */
  category?: string
  /** 仅在指定项目中可用。 */
  projectPath?: string
  /** 根据执行上下文进一步判断是否可用。 */
  isAvailable?: (ctx: Pick<ToolContext, "workingDir">) => boolean
}
