import type { AgentDefinition } from "../agent/types.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import type { ToolEffect } from "../tool/types.ts"
import {
  filterToolsForScope,
  type ExecutionScope,
  type RuntimeToolPolicy,
} from "./tool-policy.ts"

/**
 * Validate an atomic assignment before the parent yields ownership.
 *
 * Root-objective routing is intentionally not used here: a cross-domain user
 * objective may be covered by several children, while every individual child
 * must be able to satisfy its own immutable TaskContract.
 */
export function unsupportedTaskEffects(input: {
  agent: AgentDefinition
  tools: ToolRegistry
  requiredEffects: ToolEffect[]
  scope: ExecutionScope
  policy?: RuntimeToolPolicy
  workingDir: string
}): ToolEffect[] {
  if (input.agent.projectPath
    && normalizePath(input.agent.projectPath) !== normalizePath(input.workingDir)) {
    return [...new Set(input.requiredEffects)]
  }
  const registered = (input.agent.tools ?? []).flatMap((name) => {
    const tool = input.tools.get(name)
    if (!tool || (tool.isAvailable && !tool.isAvailable({ workingDir: input.workingDir }))) return []
    return [tool]
  })
  const visible = filterToolsForScope(input.agent, registered, input.scope, input.policy)
  return [...new Set(input.requiredEffects)].filter((effect) =>
    !visible.some((tool) => tool.contract.effects.includes(effect)))
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}
