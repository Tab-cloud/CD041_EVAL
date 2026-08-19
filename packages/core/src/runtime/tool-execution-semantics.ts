import type { ToolDefinition, ToolResult } from "../tool/types.ts"

export interface ToolExecutionSemantics {
  mutation: boolean
  verification: boolean
  mutationTargets: string[]
  verificationTargets: string[]
  globalVerification: boolean
}

export const NO_PROGRESS_SEMANTICS: ToolExecutionSemantics = Object.freeze({
  mutation: false,
  verification: false,
  mutationTargets: [],
  verificationTargets: [],
  globalVerification: false,
})

/**
 * Convert a tool's declared progress contract and concrete invocation into
 * objective-loop semantics. Security capabilities are intentionally not used
 * as progress: they describe what a tool could do, not what this invocation
 * contributed to completion.
 */
export function deriveToolExecutionSemantics(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  result: ToolResult,
): ToolExecutionSemantics {
  const role = tool.contract.progress.role
  const targets = extractTargets(input, tool.contract.progress.targetParameters ?? [])
  if (role === "mutation") return semantics(true, false, targets, [], false)
  if (role === "verification") return semantics(false, true, [], targets, tool.contract.progress.verificationScope === "global" || targets.length === 0)
  if (role === "inspection") return semantics(false, true, [], targets, false)
  if (role === "delegation") return semantics(false, result.success, [], targets, result.success)
  if (role === "control") return semantics(false, false, [], [], false)
  return deriveDynamicSemantics(tool, input, result, targets)
}

function deriveDynamicSemantics(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  result: ToolResult,
  targets: string[],
): ToolExecutionSemantics {
  if (tool.name === "bash") {
    const command = String(input.command ?? "")
    const mutation = /(?:^|[;&|]\s*)(?:copy|move|del|ren|mkdir|rmdir)\b|(?:>|>>)|\b(?:sed|perl)\s+-i\b/i.test(command)
    const verification = result.outcome?.category === "build"
      || /\b(?:make|cmake|ninja|ctest|cargo\s+(?:build|check|test)|go\s+test|pytest|pnpm\s+(?:test|lint|typecheck|build)|npm\s+(?:test|run\s+(?:test|lint|build))|tsc\b)/i.test(command)
    return semantics(mutation, verification, mutation ? targets : [], verification ? targets : [], verification && targets.length === 0)
  }

  // An untrusted dynamic extension is conservative: if it can write, demand
  // subsequent independent verification; otherwise a successful read/network
  // invocation may contribute evidence without pretending to mutate files.
  const mutation = tool.contract.effects.includes("workspace-write")
  const verification = !mutation && tool.contract.effects.some((effect) => effect === "workspace-read" || effect === "network" || effect === "hardware")
  return semantics(mutation, verification, mutation ? targets : [], verification ? targets : [], verification && targets.length === 0)
}

function extractTargets(input: Record<string, unknown>, fields: readonly string[]): string[] {
  const values = fields.flatMap((field) => {
    const value = input[field]
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
    return []
  })
  return [...new Set(values.map(normalizeTarget).filter(Boolean))]
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase()
}

function semantics(
  mutation: boolean,
  verification: boolean,
  mutationTargets: string[],
  verificationTargets: string[],
  globalVerification: boolean,
): ToolExecutionSemantics {
  return { mutation, verification, mutationTargets, verificationTargets, globalVerification }
}
