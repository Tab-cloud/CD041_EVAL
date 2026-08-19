import { resolve } from "node:path"
import type { AgentDefinition } from "../agent/types.ts"
import type { AgentRegistry } from "../agent/registry.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import type { ToolDefinition, ToolEffect } from "../tool/types.ts"
import type { AgentOrchestrator } from "./orchestrator.ts"
import { filterToolsForScope, type ExecutionScope, type RuntimeToolPolicy } from "./tool-policy.ts"
import { compileObjective, type ObjectiveIntent } from "./objective-compiler.ts"
import { MAIN_AGENT_ID } from "../agent/definitions/main-agent.ts"
import {
  SemanticTaskAnalysisUnavailableError,
  validateSemanticTaskAnalysis,
  type SemanticTaskAnalysis,
} from "./semantic-task-analysis.ts"

export interface RuntimeAgentSelectionInput {
  message: string
  scope: ExecutionScope
  autoPlanning: boolean
  planContinuation: boolean
  commandAgentId?: string
  requestedAgentId?: string
  continuedAgentId?: string
  configuredAgentId?: string
  workingDir: string
  orchestrator: AgentOrchestrator
  agentRegistry: AgentRegistry
  toolRegistry: ToolRegistry
  toolPolicy?: RuntimeToolPolicy
  semanticAnalysis?: SemanticTaskAnalysis
}

export interface RuntimeAgentSelection {
  /** Stable root owner. This identity never changes to a specialist. */
  agent: AgentDefinition
  /**
   * Lead specialist recommended to the main Agent. Complex objectives may be
   * covered collectively by several children; this field is not a claim that
   * one child owns every required effect.
   */
  executionAgent: AgentDefinition
  internallyReassigned: boolean
  requiredEffects: ToolEffect[]
  objective: ObjectiveIntent
  source: "command" | "requested" | "continued" | "configured" | "automatic" | "capability-reassignment"
}

/**
 * Select a stable main owner plus an execution-capable specialist.
 *
 * Commands and preferences select an assignee, never replace the root owner.
 */
export function selectRuntimeAgent(input: RuntimeAgentSelectionInput): RuntimeAgentSelection {
  const mainAgent = input.agentRegistry.get(MAIN_AGENT_ID) ?? input.agentRegistry.getDefault()
  if (!mainAgent || mainAgent.mode !== "primary") {
    throw new Error(`稳定主 Agent "${MAIN_AGENT_ID}" 未注册`)
  }
  if (!input.semanticAnalysis) {
    throw new SemanticTaskAnalysisUnavailableError("运行时角色选择缺少结构化语义协议")
  }
  const semanticAnalysis = validateSemanticTaskAnalysis(
    input.semanticAnalysis,
    new Set(input.agentRegistry.list()
      .filter((agent) => agent.mode !== "primary")
      .map((agent) => agent.id)),
  )
  const automatic = input.autoPlanning
    ? input.orchestrator.executionAgent(semanticAnalysis)
    : input.orchestrator.primaryAgent(semanticAnalysis)
  const execution = input.orchestrator.executionAgent(semanticAnalysis)
  const explicitlyRequested = lookupAssignable(input.agentRegistry, input.requestedAgentId)
  const continued = lookupAssignable(input.agentRegistry, input.continuedAgentId)
  const configured = lookupAssignable(input.agentRegistry, input.configuredAgentId)
  const command = lookupAssignable(input.agentRegistry, input.commandAgentId)
  const preferred = command ?? explicitlyRequested ?? continued ?? configured ?? automatic
  const objective = compileObjective(input.message, input.scope, {
    autoPlanning: input.autoPlanning,
    planContinuation: input.planContinuation,
    semanticAnalysis,
  })
  const requiredEffects = objective.requiredEffects

  const specialistEffects = requiredEffects.filter((effect) => !MAIN_OWNED_EFFECTS.has(effect))
  // Admission never fails merely because the currently selected role cannot
  // cover every inferred effect. The main Agent still starts with the user's
  // authorized surface and can decompose, choose another strategy, or explain
  // the permission boundary. Actual tool execution remains scope-gated.

  // Slash commands are explicit protocols, but their dedicated role remains a child assignee.
  if (command || specialistEffects.length === 0 || supports(preferred, specialistEffects, input.toolRegistry, input.workingDir, input.scope, input.toolPolicy)) {
    return {
      agent: mainAgent,
      executionAgent: preferred,
      internallyReassigned: false,
      requiredEffects,
      objective,
      source: command ? "command"
        : explicitlyRequested ? "requested"
          : continued ? "continued"
            : configured ? "configured"
              : "automatic",
    }
  }

  const candidates = uniqueAgents([
    execution,
    automatic,
    ...semanticAnalysis.candidateAgentIds
      .map((id) => input.agentRegistry.get(id)),
    ...input.agentRegistry.list(),
  ]).filter((agent) => agent.id !== mainAgent.id)
  const capable = candidates.find((agent) => supports(
    agent,
    specialistEffects,
    input.toolRegistry,
    input.workingDir,
    input.scope,
    input.toolPolicy,
  ))
  if (capable) {
    return {
      agent: mainAgent,
      executionAgent: capable,
      internallyReassigned: capable.id !== preferred.id,
      requiredEffects,
      objective,
      source: capable.id !== preferred.id ? "capability-reassignment" : "automatic",
    }
  }

  const lead = [...candidates]
    .map((agent, index) => ({
      agent,
      index,
      coverage: specialistEffects.filter((effect) => supports(
        agent,
        [effect],
        input.toolRegistry,
        input.workingDir,
        input.scope,
        input.toolPolicy,
      )).length,
    }))
    .sort((left, right) => right.coverage - left.coverage || left.index - right.index)[0]?.agent
    ?? preferred
  return {
    agent: mainAgent,
    executionAgent: lead,
    internallyReassigned: lead.id !== preferred.id,
    requiredEffects,
    objective,
    source: lead.id !== preferred.id ? "capability-reassignment" : "automatic",
  }
}

export function inferRequiredEffects(
  semanticAnalysis: SemanticTaskAnalysis,
  autoPlanning = false,
): ToolEffect[] {
  return compileObjective("", "full-access", { autoPlanning, semanticAnalysis }).requiredEffects
}

function supports(
  agent: AgentDefinition,
  effects: ToolEffect[],
  tools: ToolRegistry,
  workingDir: string,
  scope: ExecutionScope,
  policy?: RuntimeToolPolicy,
): boolean {
  if (agent.projectPath && resolve(agent.projectPath).toLowerCase() !== resolve(workingDir).toLowerCase()) return false
  const definitions = agent.tools
    .map((name) => tools.get(name))
    .filter((tool): tool is ToolDefinition => Boolean(tool && (!tool.isAvailable || tool.isAvailable({ workingDir }))))
  const visible = filterToolsForScope(agent, definitions, scope, policy)
  return effects.every((effect) => visible.some((tool) => tool.contract.effects.includes(effect)))
}

function lookup(registry: AgentRegistry, id?: string): AgentDefinition | undefined {
  return id ? registry.get(id) : undefined
}

function lookupAssignable(registry: AgentRegistry, id?: string): AgentDefinition | undefined {
  const agent = lookup(registry, id)
  return agent?.id === MAIN_AGENT_ID ? undefined : agent
}

function uniqueAgents(agents: Array<AgentDefinition | undefined>): AgentDefinition[] {
  const seen = new Set<string>()
  return agents.filter((agent): agent is AgentDefinition => {
    if (!agent || seen.has(agent.id)) return false
    seen.add(agent.id)
    return true
  })
}

const MAIN_OWNED_EFFECTS = new Set<ToolEffect>([
  "delegation",
  "user-interaction",
])
