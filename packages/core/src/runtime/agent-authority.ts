import type { AgentDefinition } from "../agent/types.ts"
import { resolve } from "node:path"

const ROOT_ONLY_TOOLS = new Set(["task", "delegate_dag"])

/**
 * Resolve the effective tool authority for one Agent run.
 *
 * The primary root is the user's durable owner and must be able to recover any
 * work delegated to a subordinate role. Its visible tool surface is therefore
 * the union of every registered Agent's declared tools. Subordinate runs keep
 * their own allowlist and can never receive root orchestration tools.
 *
 * This only establishes the Agent hierarchy. Execution scope, system policy,
 * user approval and delegated resource capabilities remain independent upper
 * bounds and are applied later by the tool policy.
 */
export function resolveAgentAuthority(
  agent: AgentDefinition,
  registeredAgents: readonly AgentDefinition[],
  runType: "root" | "subagent" | "workflow-node" | undefined,
  workingDir: string,
): AgentDefinition {
  if (runType === "root" && agent.mode !== "primary") {
    throw new Error(`根运行必须由 primary Agent 持有，不能交给 ${agent.id}`)
  }

  if (agent.mode === "primary" && runType === "root") {
    return {
      ...agent,
      tools: unique([
        ...agent.tools,
        ...registeredAgents
          .filter((candidate) => belongsToWorkspace(candidate, workingDir))
          .flatMap((candidate) => candidate.tools),
      ]),
    }
  }

  return {
    ...agent,
    tools: unique(agent.tools.filter((name) => !ROOT_ONLY_TOOLS.has(name))),
  }
}

/** Root orchestration tools may never be injected into subordinate runs. */
export function isRootOnlyTool(name: string): boolean {
  return ROOT_ONLY_TOOLS.has(name)
}

function belongsToWorkspace(agent: AgentDefinition, workingDir: string): boolean {
  return !agent.projectPath
    || resolve(agent.projectPath).toLowerCase() === resolve(workingDir).toLowerCase()
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
