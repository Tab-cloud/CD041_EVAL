import type { AgentRegistry } from "../agent/registry.ts"
import type { ModelRouter } from "../model-router/index.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import type { AgentOrchestrator } from "./orchestrator.ts"
import type { ConversationTurnKind } from "./conversation-turn-intent.ts"
import { resolveExecutionFlow } from "./execution-flow.ts"
import { selectRuntimeAgent } from "./runtime-agent-selection.ts"
import { shouldAutoPlan } from "./server-chat-policy.ts"
import {
  analyzeSemanticTask,
  fallbackSemanticTaskAnalysis,
} from "./semantic-task-analysis.ts"
import type {
  SemanticTaskAnalysis,
  SemanticTaskResource,
} from "./semantic-task-analysis.ts"
import type { SystemSettings } from "./system-settings.ts"
import type { ExecutionScope } from "./tool-policy.ts"
import { normalizeStructuredObjectiveIntent } from "./objective-compiler.ts"
import { resolveConversationExecutionAuthority } from "./conversation-execution-authority.ts"

const RESOURCE_INSPECTION_EFFECTS = new Set(["workspace-read"])
const RESOURCE_INSPECTION_VERIFIERS = new Set([
  "source-inspection",
  "workspace-inspection",
  "datasheet-inspection",
  "schematic-inspection",
])

export async function resolveRootAgentRouting(input: {
  message: string
  resources?: SemanticTaskResource[]
  scope: ExecutionScope
  sessionId: string
  requestId: string
  /** Stable main-Agent root which owns this interpretation attempt. */
  rootRunId: string
  workingDir: string
  preferredModelId?: string
  modelRouter: ModelRouter | null
  agentRegistry: AgentRegistry
  toolRegistry: ToolRegistry
  orchestrator: AgentOrchestrator
  systemSettings: SystemSettings
  turnKind: ConversationTurnKind
  mayAutoPlan: boolean
  planContinuation: boolean
  commandAgentId?: string
  requestedAgentId?: string
  continuedAgentId?: string
  configuredAgentId?: string
  signal?: AbortSignal
  semanticTaskAnalyzer?: typeof analyzeSemanticTask
}) {
  // One model-owned semantic protocol feeds every downstream routing decision.
  let analyzed: SemanticTaskAnalysis
  try {
    analyzed = await (input.semanticTaskAnalyzer ?? analyzeSemanticTask)({
      message: input.message,
      resources: input.resources,
      scope: input.scope,
      turnKind: input.turnKind,
      agents: input.agentRegistry.list(),
      modelRouter: input.modelRouter,
      preferredModelId: input.preferredModelId,
      modelFallbackEnabled: input.systemSettings.modelFallbackEnabled,
      sessionId: input.sessionId,
      runId: input.rootRunId,
      abortSignal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted) throw error
    analyzed = fallbackSemanticTaskAnalysis(error)
  }
  const semanticAnalysis = constrainSemanticAnalysisForTurn(
    analyzed,
    input.turnKind,
    input.resources,
    input.scope,
  )
  const autoPlanning = input.mayAutoPlan && shouldAutoPlan(
    input.scope,
    input.orchestrator,
    input.turnKind,
    semanticAnalysis,
  )
  const executionFlow = resolveExecutionFlow(input.scope, autoPlanning)
  const selectedAgent = selectRuntimeAgent({
    message: input.message,
    scope: input.scope,
    autoPlanning,
    planContinuation: input.planContinuation,
    commandAgentId: input.commandAgentId,
    requestedAgentId: input.requestedAgentId,
    continuedAgentId: input.continuedAgentId,
    configuredAgentId: input.configuredAgentId,
    workingDir: input.workingDir,
    orchestrator: input.orchestrator,
    agentRegistry: input.agentRegistry,
    toolRegistry: input.toolRegistry,
    toolPolicy: {
      toolPolicies: input.systemSettings.toolPolicies,
      communityAutomation: input.systemSettings.communityAutomation,
      writePathAllowlist: input.systemSettings.writePathAllowlist,
      commandAllowlist: input.systemSettings.commandAllowlist,
      workingDir: input.workingDir,
    },
    semanticAnalysis,
  })
  return { semanticAnalysis, autoPlanning, executionFlow, selectedAgent }
}

/**
 * Conversation intent is an independent authority boundary. A model may
 * describe a domain question as complex hardware/build work, but the runtime
 * must not let an informational turn acquire operational effects.
 */
export function constrainSemanticAnalysisForTurn(
  analysis: SemanticTaskAnalysis,
  turnKind: ConversationTurnKind,
  resources: SemanticTaskResource[] = [],
  _scope: ExecutionScope = "full-access",
): SemanticTaskAnalysis {
  const authority = resolveConversationExecutionAuthority(turnKind)
  if (authority === "status") {
    const normalized = normalizeStructuredObjectiveIntent({
      ...analysis,
      requiredEffects: [],
      requiresPlanning: false,
      acceptanceRequirements: [],
    })
    return { ...normalized, complexity: "simple", source: analysis.source }
  }
  if (authority === "operational") return analysis

  // Information capabilities are optional for a response; they are not
  // acceptance obligations. The sole exception is inspection of a resource
  // admitted with the current turn, where failing to read it would permit a
  // fabricated summary. This reconciliation is structural: no language or
  // embedded-domain keyword participates in the decision.
  const requiresResourceInspection = resources.length > 0
    && analysis.requiredEffects.includes("workspace-read")
  const normalized = normalizeStructuredObjectiveIntent({
    ...analysis,
    requiredEffects: requiresResourceInspection
      ? analysis.requiredEffects.filter((effect) => RESOURCE_INSPECTION_EFFECTS.has(effect))
      : [],
    requiresPlanning: false,
    acceptanceRequirements: requiresResourceInspection
      ? analysis.acceptanceRequirements.filter((requirement) =>
          RESOURCE_INSPECTION_VERIFIERS.has(requirement.verifier))
      : [],
  })
  return {
    ...normalized,
    complexity: "simple",
    source: analysis.source,
  }
}
