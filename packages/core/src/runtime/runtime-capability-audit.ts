import type { AgentDefinition } from "../agent/types.ts"
import type { AgentRegistry } from "../agent/registry.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import type { ToolDefinition, ToolEffect } from "../tool/types.ts"

export interface RuntimeCapabilityAudit {
  errors: string[]
  warnings: string[]
  agentCount: number
  toolCount: number
}

const CONTROL_TOOLS = ["todowrite", "task", "delegate_dag"] as const
const ROOT_ONLY_TOOLS = ["task", "delegate_dag"] as const
const DANGEROUS_ACTION = /(?:flash|program|download|erase|write|reset|detach|send|open|close|connect|disconnect|halt|resume|step|breakpoint|set)/i

/**
 * Fail-fast validation for the runtime capability graph. Prompt text must not
 * be the first place an invalid role/tool configuration is discovered.
 */
export function auditRuntimeCapabilities(
  agents: AgentRegistry,
  tools: ToolRegistry,
): RuntimeCapabilityAudit {
  const definitions = agents.list()
  const availableTools = tools.list()
  const toolNames = new Set(availableTools.map((tool) => tool.name))
  const errors: string[] = []
  const warnings: string[] = []

  for (const required of CONTROL_TOOLS) {
    if (!toolNames.has(required)) errors.push(`缺少运行时控制工具: ${required}`)
  }

  const primaryAgents = definitions.filter((agent) => agent.mode === "primary")
  if (primaryAgents.length !== 1) {
    errors.push(`运行时必须且只能注册一个 primary 主 Agent，当前数量: ${primaryAgents.length}`)
  }
  const primary = primaryAgents[0]
  if (primary) {
    for (const name of ROOT_ONLY_TOOLS) {
      if (!primary.tools.includes(name)) errors.push(`主 Agent 缺少根级编排工具: ${name}`)
    }
  }

  for (const tool of availableTools) {
    const report = auditToolExecutionContract(tool)
    errors.push(...report.errors)
    warnings.push(...report.warnings)
  }

  for (const agent of definitions) {
    if (agent.mode !== "primary") {
      for (const name of ROOT_ONLY_TOOLS) {
        if (agent.tools.includes(name)) errors.push(`子 Agent ${agent.id} 不得声明根级编排工具: ${name}`)
      }
    }
    const seen = new Set<string>()
    for (const name of agent.tools) {
      if (seen.has(name)) warnings.push(`Agent ${agent.id} 重复声明工具: ${name}`)
      seen.add(name)
      if (!toolNames.has(name)) errors.push(`Agent ${agent.id} 引用了未注册工具: ${name}`)
      const tool = tools.get(name)
      if (tool && !agent.permissions.some((rule) =>
        rule.permission === tool.permission || rule.permission === "*")) {
        errors.push(`Agent ${agent.id} 声明工具 ${name}，但没有 ${tool.permission} 权限规则`)
      }
    }
    validateDelegationPermission(agent, errors)
  }

  const coordinator = definitions.find((agent) => supportsEffects(agent, tools, ["workspace-write", "process", "delegation"]))
  if (!coordinator) {
    errors.push("没有任何 Agent 同时具备写入、进程执行和任务委派能力，复杂执行请求会被困在只读角色")
  }

  const executionRoles = definitions.filter((agent) => agent.tools.some((name) => {
    const tool = tools.get(name)
    return Boolean(tool?.contract.effects.some((effect) => effect === "workspace-write" || effect === "process" || effect === "hardware"))
  }))
  for (const agent of executionRoles) {
    if (!toolNames.has("todowrite")) break
    if (!agent.tools.includes("todowrite")) {
      warnings.push(`Agent ${agent.id} 未显式声明 todowrite；运行时将自动注入控制面工具`)
    }
  }

  return { errors, warnings, agentCount: definitions.length, toolCount: availableTools.length }
}

/**
 * Validate the machine-readable tool manifest itself. Runtime authorization,
 * progress tracking and recovery all consume this contract, so a field-name
 * drift must fail during startup instead of surfacing as a spurious "*" target
 * after a delegated Agent has already started.
 */
export function auditToolExecutionContract(
  tool: ToolDefinition,
): Pick<RuntimeCapabilityAudit, "errors" | "warnings"> {
  const errors: string[] = []
  const warnings: string[] = []
  const schema = tool.parameters as {
    type?: unknown
    properties?: Record<string, unknown>
    required?: unknown
  }
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : {}
  const targets = tool.contract.progress.targetParameters ?? []

  if (schema.type !== "object") {
    errors.push(`工具 ${tool.name} 的参数 Schema 必须是 object`)
  }
  for (const target of targets) {
    if (!(target in properties)) {
      errors.push(`工具 ${tool.name} 的目标参数 ${target} 不存在于参数 Schema`)
    }
  }
  if (new Set(targets).size !== targets.length) {
    warnings.push(`工具 ${tool.name} 重复声明目标参数`)
  }
  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (typeof field !== "string" || !(field in properties)) {
        errors.push(`工具 ${tool.name} 的必填参数 ${String(field)} 不存在于参数 Schema`)
      }
    }
  }

  const { effects, idempotency, cancellation, progress } = tool.contract
  const alwaysEffects = tool.contract.alwaysEffects ?? effects
  if (alwaysEffects.some((effect) => !effects.includes(effect))) {
    errors.push(`工具 ${tool.name} 的 alwaysEffects 必须是 effects 的子集`)
  }
  if (new Set(alwaysEffects).size !== alwaysEffects.length) {
    warnings.push(`工具 ${tool.name} 的 alwaysEffects 包含重复项`)
  }
  if (idempotency === "read-only" && effects.includes("workspace-write")) {
    errors.push(`工具 ${tool.name} 声明只读幂等性但具有 workspace-write 效果`)
  }
  if (progress.role === "mutation" && !effects.includes("workspace-write")) {
    errors.push(`工具 ${tool.name} 声明 mutation 进展但没有 workspace-write 效果`)
  }
  if (progress.role === "inspection" && effects.includes("workspace-write")) {
    errors.push(`工具 ${tool.name} 声明 inspection 进展但具有 workspace-write 效果`)
  }
  if (progress.verificationScope && progress.role !== "verification") {
    errors.push(`工具 ${tool.name} 仅 verification 角色可以声明 verificationScope`)
  }
  if (progress.verificationScope === "targeted" && targets.length === 0) {
    errors.push(`工具 ${tool.name} 的 targeted verification 必须声明目标参数`)
  }

  const actionSchema = properties.action as { enum?: unknown } | undefined
  const actions = Array.isArray(actionSchema?.enum)
    ? actionSchema.enum.filter((value): value is string => typeof value === "string")
    : []
  const dangerousActions = actions.filter((action) => DANGEROUS_ACTION.test(action))
  if (dangerousActions.length > 0) {
    const label = dangerousActions.join(", ")
    if (idempotency === "read-only") {
      errors.push(`工具 ${tool.name} 的危险动作 ${label} 不能声明为 read-only`)
    }
    if (progress.role === "inspection") {
      errors.push(`工具 ${tool.name} 的危险动作 ${label} 不能声明为 inspection`)
    }
    if (!effects.some((effect) =>
      effect === "workspace-write" || effect === "process" || effect === "hardware")) {
      errors.push(`工具 ${tool.name} 的危险动作 ${label} 缺少可执行副作用声明`)
    }
  }

  if (effects.includes("process") && cancellation === "unsupported") {
    warnings.push(`工具 ${tool.name} 启动进程但不支持取消`)
  }
  return { errors, warnings }
}

export function assertRuntimeCapabilities(agents: AgentRegistry, tools: ToolRegistry): RuntimeCapabilityAudit {
  const report = auditRuntimeCapabilities(agents, tools)
  if (report.errors.length > 0) throw new Error(`Agent/工具能力图无效:\n- ${report.errors.join("\n- ")}`)
  return report
}

function supportsEffects(agent: AgentDefinition, tools: ToolRegistry, effects: ToolEffect[]): boolean {
  const definitions = agent.tools.flatMap((name) => {
    const tool = tools.get(name)
    return tool ? [tool] : []
  })
  return effects.every((effect) => definitions.some((tool) => tool.contract.effects.includes(effect)))
}

function validateDelegationPermission(agent: AgentDefinition, errors: string[]): void {
  if (!agent.tools.includes("task")) return
  const exact = agent.permissions.filter((rule) => rule.permission === "task" && rule.pattern === "*").at(-1)
  if (exact?.effect === "deny") errors.push(`Agent ${agent.id} 声明了 task，但权限规则明确拒绝 task`)
}
