import type { ToolEffect } from "../tool/types.ts"
import type { ObjectiveVerifier } from "./objective-compiler.ts"

export interface RecoveryToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  effects?: readonly ToolEffect[]
  progressRole?: "control" | "inspection" | "mutation" | "verification" | "delegation" | "dynamic"
}

/**
 * Recover an operational turn that stopped in prose while runtime acceptance
 * is still open. The verifier types come from the runtime contract, never from
 * user wording. Control-plane bookkeeping is excluded so the required call
 * must have a chance to advance the objective.
 */
export function resolveOutstandingWorkToolPolicy(
  allTools: RecoveryToolSchema[],
  verifiers: readonly ObjectiveVerifier[],
): RecoveryToolPolicy {
  return {
    tools: allTools,
    instruction: verifiers.length > 0
      ? `运行时验收仍缺少以下类型的证据：${[...new Set(verifiers)].join(", ")}`
      : "运行时仍有未完成工作，请选择一个能够形成业务进展的工具",
    // Evidence gaps are advice for the LLM, not a runtime command to call one
    // particular tool. Permissions still determine which tools are visible.
    requireTool: false,
  }
}

export interface RecoveryToolPolicy {
  tools: RecoveryToolSchema[]
  instruction?: string
  requireTool: boolean
}

export interface RecoveryDirectiveInput {
  sourceTool: string
  summary: string
  actions: string[]
  actionIndex: number
  actionTools?: string[][]
  actionEffects?: ToolEffect[][]
}

/**
 * Select the recovery surface from a machine-readable contract.
 *
 * Human-language action text is shown to the model but is never parsed to
 * choose a tool. Recovery hints are advisory: the runtime always exposes the
 * complete authorized surface so the LLM can change strategy.
 */
export function resolveRecoveryToolPolicy(
  allTools: RecoveryToolSchema[],
  _todo?: { content?: string; acceptance?: string },
  recovery?: RecoveryDirectiveInput,
): RecoveryToolPolicy {
  const actionIndex = recovery
    ? Math.min(Math.max(0, recovery.actionIndex), Math.max(0, recovery.actions.length - 1))
    : 0
  return {
    tools: allTools,
    instruction: recovery?.actions[actionIndex],
    requireTool: false,
  }
}

/** Select the exact control tools required by an explicit execution phase. */
export function resolveRequiredPhaseToolPolicy(
  allTools: RecoveryToolSchema[],
  requiredToolNames: readonly string[],
): RecoveryToolPolicy {
  const required = new Set(requiredToolNames)
  const tools = allTools.filter((tool) => required.has(tool.name))
  return {
    tools,
    instruction: tools.length > 0
      ? `完成当前执行阶段要求的控制动作：${tools.map((tool) => tool.name).join(", ")}`
      : undefined,
    requireTool: tools.length > 0,
  }
}
