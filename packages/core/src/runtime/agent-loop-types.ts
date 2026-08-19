import type { AgentRegistry } from "../agent/registry.ts"
import type { ModelRouter } from "../model-router/index.ts"
import type { ModelCapability } from "../model-router/types.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import type {
  AgentActivityEvent,
  SearchRuntimeConfig,
  ToolContext,
} from "../tool/types.ts"
import type { ExecutionControllerOptions } from "./agent-loop-control.ts"
import type { ExecutionBudgetPolicy } from "./execution-budget.ts"
import type { ExecutablePlan } from "./executable-plan.ts"
import type { ObjectiveAcceptancePolicy } from "./objective-compiler.ts"
import type { ResourceClaims } from "./run-contract.ts"
import type { ExecutionScope, RuntimeToolPolicy } from "./tool-policy.ts"
import type { ToolEffect } from "../tool/types.ts"

export interface AgentLoopInput {
  /** Stable run identity; never overload sessionId for child execution lineage. */
  runId?: string
  parentRunId?: string
  runType: "root" | "subagent" | "workflow-node"
  /** Monotonic continuation segment within the root run. */
  executionSegment?: number
  /** Checkpoints are isolated per execution while root chat keeps session recovery compatibility. */
  checkpointKey?: string
  sessionId: string
  /** Root permission context; conversation/session IDs may differ for child Agents. */
  permissionContextId?: string
  userMessage: string
  agentId: string
  /** Root owner identity stays stable while task-specific model capabilities follow the selected assignee. */
  requiredCapabilities?: ModelCapability[]
  workingDir: string
  history?: Array<{
    role: "user" | "assistant" | "tool"
    content: string
    toolCalls?: any[]
    toolResults?: any[]
    reasoningContent?: string
    reasoningDetails?: Array<Record<string, unknown>>
    originModelId?: string
  }>
  attachments?: Array<{
    name: string
    mime: string
    kind: "image" | "text" | "binary"
    dataUrl?: string
    content?: string
  }>
  scope?: ExecutionScope
  effort?: string
  workflowContext?: string
  abortSignal?: AbortSignal
  preferredModelId?: string
  /** Per-Agent routes inherited by delegated child runs. */
  agentModelRoutes?: Record<string, { primaryModelId: string; fallbackModelIds: string[] }>
  disabledTools?: string[]
  /** Per-objective effect envelope compiled at semantic admission. */
  objectiveEffects?: ToolEffect[]
  /**
   * Exact runtime control-plane tools leased to the active execution phase.
   * They bypass only the objective effect envelope, never scope, system policy,
   * the Agent allowlist, or explicit disabled-tool settings.
   */
  phaseControlTools?: string[]
  /** Phase protocol tools that must be visible before any model request. */
  requiredPhaseTools?: string[]
  disabledSkills?: string[]
  toolPolicy?: RuntimeToolPolicy
  /** Immutable capability inherited from the parent TaskContract. */
  resourceClaims?: ResourceClaims
  /** Runtime-owned executable plan for the current execution phase. */
  activePlan?: ExecutablePlan
  searchConfig?: SearchRuntimeConfig
  modelFallbackEnabled?: boolean
  fallbackModelIds?: string[]
  /** Internal executor candidates used only after the selected model proves it cannot emit native tool calls. */
  protocolExecutorModelIds?: string[]
  /** Concrete tasks projected from a durable main-Agent proposal. */
  objectiveTodos?: string[]
  /** Exact durable objective revision that owns the new execution graph. */
  conversationObjective?: { id: string; fingerprint: string }
  /** Durable semantic execution state; this is the only authoritative todo/run source. */
  executionState?: ExecutionControllerOptions
  /** Runtime-owned acceptance contract compiled from the user's objective. */
  objectiveAcceptancePolicy?: ObjectiveAcceptancePolicy
  /** Internal inbox owned by the main Agent; never projected as public SSE. */
  onSubAgentInteraction?: ToolContext["onSubAgentInteraction"]
  /** Optional hard cap imposed by a parent orchestration boundary. */
  maxStepsOverride?: number
  /** Absolute deadline for this run; children receive a bounded earlier deadline. */
  executionDeadline?: number
  /** Root/child lease policy; child Agents cannot consume the parent's recovery reserve. */
  executionBudget?: ExecutionBudgetPolicy
  activityOutput?: (event: AgentActivityEvent) => void
  /**
   * Durable user steers for this exact root run. The callback is polled only
   * at model/tool protocol boundaries, so a guidance message can never split
   * an assistant tool-call from its required tool result.
   */
  drainGuidance?: () => Array<{
    requestId: string
    message: string
    attachments?: Array<{
      name: string
      mime: string
      kind: "image" | "text" | "binary"
      dataUrl?: string
      content?: string
    }>
  }>
  /** Scheduler suspension boundary for application-level user interaction. */
  executionGate?: {
    suspendForApproval: (reason: string) => void
    resumeAfterApproval: () => Promise<void>
  }
}

export interface AgentLoopContext {
  toolRegistry: ToolRegistry
  agentRegistry: AgentRegistry
  modelRouter: ModelRouter
}
