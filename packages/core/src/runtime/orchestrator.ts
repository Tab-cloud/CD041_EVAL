/**
 * AgentOrchestrator — consumes a validated semantic task analysis.
 *
 * Natural-language interpretation is deliberately absent here. The semantic
 * analyzer resolves paraphrases, pinyin and cross-domain intent once at the
 * request boundary; this class only maps registered Agent IDs to live
 * definitions. Model routing remains a separate concern.
 */
import type { AgentDefinition } from "../agent/types.ts"
import { HIDDEN_AGENTS } from "../agent/definitions/all.ts"
import type { ObjectiveGoalType } from "./objective-compiler.ts"
import type { SemanticTaskAnalysis } from "./semantic-task-analysis.ts"
import { TaskDecomposer } from "./planner.ts"

export type TaskType = ObjectiveGoalType

export interface AgentMatch {
  agent: AgentDefinition
  taskType: TaskType
  score: number
}

export class SemanticAgentResolutionError extends Error {
  readonly code = "semantic-agent-resolution-failed"

  constructor(candidateAgentIds: string[]) {
    super(`结构化语义候选没有映射到可执行 Agent: ${candidateAgentIds.join(", ") || "(empty)"}`)
    this.name = "SemanticAgentResolutionError"
  }
}

export class AgentOrchestrator {
  private agents = new Map<string, AgentDefinition>()
  private readonly agentSource: () => AgentDefinition[]

  constructor(source: AgentDefinition[] | (() => AgentDefinition[]) = HIDDEN_AGENTS) {
    this.agentSource = typeof source === "function" ? source : () => source
    this.refreshAgents()
  }

  /** Resolve validated semantic candidates against the current live registry. */
  classify(input: SemanticTaskAnalysis): AgentMatch[] {
    this.refreshAgents()
    const candidateIds = input.candidateAgentIds
    const matches: AgentMatch[] = []
    const seen = new Set<string>()
    for (const [index, id] of candidateIds.entries()) {
      const agent = this.agents.get(id)
      if (!agent || agent.mode === "primary" || seen.has(agent.id)) continue
      seen.add(agent.id)
      matches.push({
        agent,
        taskType: input.goalType,
        score: Math.max(1, candidateIds.length - index),
      })
    }
    if (matches.length === 0) {
      throw new SemanticAgentResolutionError(candidateIds)
    }
    return matches
  }

  primaryAgent(input: SemanticTaskAnalysis): AgentDefinition {
    return this.classify(input)[0]!.agent
  }

  executionAgent(input: SemanticTaskAnalysis): AgentDefinition {
    return this.classify(input)[0]!.agent
  }

  allAgents(input: SemanticTaskAnalysis, maxAgents = 3): AgentDefinition[] {
    return this.classify(input).slice(0, maxAgents).map((match) => match.agent)
  }

  /** Planning is a model-owned semantic decision, not a phrase detector. */
  needsDecomposition(input: SemanticTaskAnalysis): boolean {
    return input.requiresPlanning
  }

  buildDecompositionPrompt(goal: string): string {
    const decomposer = new TaskDecomposer()
    return decomposer.buildDecompositionPrompt(goal, [...this.agents.values()])
  }

  get(id: string): AgentDefinition | undefined {
    this.refreshAgents()
    return this.agents.get(id)
  }

  list(): AgentDefinition[] {
    this.refreshAgents()
    return [...this.agents.values()]
  }

  explain(input: SemanticTaskAnalysis): string {
    return this.classify(input)
      .slice(0, 3)
      .map((match) => `**${match.agent.name}** (${match.taskType})`)
      .join(" → ")
  }

  /**
   * Planning context derives from the semantic candidate set. There is no
   * hidden trigger vocabulary or fixed phrase-to-workflow table.
   */
  getWorkflowContext(input: SemanticTaskAnalysis): string | null {
    if (!input.requiresPlanning) return null
    const steps = this.allAgents(input, 8)
      .map((agent, index) => `  ${index + 1}. **${agent.name}** — ${agent.description}`)
      .join("\n")
    if (!steps) return null
    return [
      "## 已识别结构化多 Agent 任务",
      "主 Agent 按依赖关系创建子任务、分配以下候选 Agent，并汇总各节点结果：",
      steps,
    ].join("\n")
  }

  private refreshAgents(): void {
    this.agents = new Map(this.agentSource().map((agent) => [agent.id, agent]))
  }
}
