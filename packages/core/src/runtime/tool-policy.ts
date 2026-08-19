import type { AgentDefinition } from "../agent/types.ts"
import type { ToolDefinition, ToolEffect } from "../tool/types.ts"
import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { normalizeResourceClaims, type ResourceClaims } from "./run-contract.ts"

export type ExecutionScope = "full-access" | "auto-edit" | "plan-mode" | "confirm-changes"
export type ToolPolicyMode = "allow" | "ask" | "deny"

export interface ToolPolicySettings {
  fileWrite: ToolPolicyMode
  terminal: ToolPolicyMode
  network: ToolPolicyMode
  hardware: ToolPolicyMode
}

export interface CommunityAutomationSettings {
  enabled: boolean
  forumExplore: ToolPolicyMode
  forumReply: ToolPolicyMode
  forumCreateTopic: ToolPolicyMode
  blogCreateDraft: ToolPolicyMode
  blogPublish: ToolPolicyMode
}

export interface RuntimeToolPolicy {
  toolPolicies: ToolPolicySettings
  communityAutomation?: CommunityAutomationSettings
  writePathAllowlist: string[]
  commandAllowlist: string[]
  /** Workspace used to canonicalize allowlisted write targets. */
  workingDir?: string
}

/** Capability issued by a parent TaskContract to one delegated execution. */
export interface ToolCapabilityBoundary {
  workingDir: string
  resources: ResourceClaims
}

const VALID_SCOPES = new Set<ExecutionScope>([
  "full-access",
  "auto-edit",
  "plan-mode",
  "confirm-changes",
])

const READ_ONLY_PERMISSIONS = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "skill",
  "question",
  "plan",
  "todowrite",
  "schematic",
  "community.read",
])

const COMMUNITY_POLICY_BY_TOOL: Record<string, keyof Omit<CommunityAutomationSettings, "enabled">> = {
  community_forum_list: "forumExplore",
  community_forum_read: "forumExplore",
  community_forum_create_topic: "forumCreateTopic",
  community_forum_reply: "forumReply",
  community_blog_create_draft: "blogCreateDraft",
  community_blog_update_draft: "blogCreateDraft",
  community_blog_publish: "blogPublish",
}

const COMMUNITY_WRITE_TOOLS = new Set([
  "community_forum_create_topic",
  "community_forum_reply",
  "community_blog_create_draft",
  "community_blog_update_draft",
  "community_blog_publish",
])

export type ToolAuthorization =
  | { action: "allow" }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string }

export function normalizeScope(value: unknown): ExecutionScope | null {
  return typeof value === "string" && VALID_SCOPES.has(value as ExecutionScope)
    ? value as ExecutionScope
    : null
}

export function filterToolsForScope(
  agent: AgentDefinition,
  tools: ToolDefinition[],
  scope: ExecutionScope,
  policy?: RuntimeToolPolicy,
): ToolDefinition[] {
  return tools.filter((tool) => {
    if (!agent.tools.includes(tool.name) && !(scope === "plan-mode" && ["plan", "todowrite"].includes(tool.name))) {
      return false
    }
    const effects = visibilityEffects(tool)
    return scopeAllows(tool, scope, effects) && policyMode(policy, effects, tool.name) !== "deny"
  })
}

export function authorizeTool(
  agent: AgentDefinition,
  tool: ToolDefinition | undefined,
  visibleToolNames: ReadonlySet<string>,
  scope: ExecutionScope,
): string | null {
  const decision = evaluateToolAuthorization(agent, tool, visibleToolNames, scope, {})
  return decision.action === "allow" ? null : decision.reason
}

export function evaluateToolAuthorization(
  agent: AgentDefinition,
  tool: ToolDefinition | undefined,
  visibleToolNames: ReadonlySet<string>,
  scope: ExecutionScope,
  input: Record<string, unknown>,
  policy?: RuntimeToolPolicy,
  capability?: ToolCapabilityBoundary,
): ToolAuthorization {
  if (!tool || !visibleToolNames.has(tool.name)) {
    return { action: "deny", reason: `工具不在 Agent "${agent.id}" 当前可用的白名单中` }
  }

  const effects = toolAuthorizationEffects(tool, input)
  if (!scopeAllows(tool, scope, effects)) {
    return { action: "deny", reason: `当前执行范围 "${scope}" 不允许 ${tool.permission} 操作` }
  }

  const targets = authorizationTargets(input, tool.contract.progress.targetParameters)
  const displayTarget = targets.join(", ")
  // The primary Agent is the user's root business authority. Agent-role rules
  // narrow subordinate workers; they cannot make the root less capable than a
  // worker it must recover. This does not bypass scope, delegated resources,
  // system policy or user approval, all of which are enforced below.
  const applicableRules = agent.mode === "primary"
    ? []
    : agent.permissions.filter((rule) =>
        rule.permission === tool.permission || rule.permission === "*")
  const matchingRules = targets.map((target) => agent.mode === "primary"
    ? { permission: tool.permission, pattern: "*", effect: "allow" as const }
    : mostSpecificRule(
        applicableRules.filter((rule) => matchesPattern(target, rule.pattern)),
        tool.permission,
      ))
  if (matchingRules.some((rule) => !rule)) {
    return { action: "deny", reason: `Agent "${agent.id}" 未授权对 ${displayTarget} 执行 ${tool.permission} 操作` }
  }
  if (matchingRules.some((rule) => rule?.effect === "deny")) {
    return { action: "deny", reason: `Agent "${agent.id}" 明确禁止 ${tool.permission} 操作` }
  }
  const capabilityDenial = capabilityAuthorization(tool, input, targets, effects, capability)
  if (capabilityDenial) return { action: "deny", reason: capabilityDenial }

  const mode = policyMode(policy, effects, tool.name)
  if (mode === "deny") {
    return { action: "deny", reason: `系统工具策略已禁止 ${toolCategoryLabel(effects)}操作` }
  }
  if (policy && effects.includes("workspace-write") && policy.writePathAllowlist.length > 0) {
    // A shell command can touch arbitrary files that are not represented by
    // its command string. A path allowlist therefore cannot safely authorize
    // shell writes; callers can use the structured file tools instead.
    if (tool.permission === "bash") {
      return { action: "deny", reason: "启用写入路径白名单时，命令行写入无法证明目标路径，已拒绝执行" }
    }
    const canonicalTargets = targets.map((target) => canonicalPolicyTarget(target, policy.workingDir))
    const allowlist = policy.writePathAllowlist
      .map((pattern) => normalizePolicyPattern(pattern))
      .filter((pattern): pattern is string => Boolean(pattern))
    if (canonicalTargets.some((target) => target === "*" || target.startsWith("external:")
      || !allowlist.some((pattern) => matchesPattern(target, pattern)))) {
      return { action: "deny", reason: `目标 ${displayTarget} 不在系统写入路径白名单中` }
    }
  }
  const commandTarget = typeof input.command === "string" ? input.command : targets[0]
  if (policy && tool.permission === "bash" && policy.commandAllowlist.length > 0
    && (!isSingleAllowlistedCommand(commandTarget)
      || !policy.commandAllowlist.some((pattern) => matchesPattern(commandTarget, pattern)))) {
    return { action: "deny", reason: "命令不在系统命令白名单中，或包含复合执行/重定向语法" }
  }
  if (matchingRules.some((rule) => rule?.effect === "ask")) {
    return { action: "ask", reason: `Agent "${agent.id}" 要求确认 ${tool.permission} 操作` }
  }
  if (mode === "ask") {
    return { action: "ask", reason: `系统工具策略要求确认${toolCategoryLabel(effects)}操作` }
  }
  if (scope === "confirm-changes" && effects.includes("workspace-write")) {
    return { action: "ask", reason: `即将通过 ${tool.name} 修改工作空间` }
  }
  return { action: "allow" }
}

function mostSpecificRule(
  rules: AgentDefinition["permissions"],
  permission: string,
): AgentDefinition["permissions"][number] | undefined {
  return [...rules].sort((left, right) => {
    const permissionDelta = Number(right.permission === permission) - Number(left.permission === permission)
    if (permissionDelta) return permissionDelta
    const patternDelta = patternSpecificity(right.pattern) - patternSpecificity(left.pattern)
    if (patternDelta) return patternDelta
    // At equal specificity fail closed: deny outranks ask, ask outranks allow.
    return effectRank(right.effect) - effectRank(left.effect)
  })[0]
}

function patternSpecificity(pattern: string): number {
  const literal = pattern.replace(/\*/g, "").length
  const segments = pattern.split("/").filter((segment) => segment && segment !== "*" && segment !== "**").length
  return literal * 10 + segments
}

function effectRank(effect: "allow" | "deny" | "ask"): number {
  return effect === "deny" ? 3 : effect === "ask" ? 2 : 1
}

function capabilityAuthorization(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  rawTargets: string[],
  effects: readonly ToolEffect[],
  capability?: ToolCapabilityBoundary,
): string | null {
  if (!capability) return null
  const writes = effects.includes("workspace-write")
  const reads = effects.includes("workspace-read")
  if (!writes && !reads) return null
  const allowed = writes
    ? capability.resources.writes
    : [...capability.resources.reads, ...capability.resources.writes]
  if (allowed.length === 0) {
    return `TaskContract 未授予 ${writes ? "写入" : "读取"}任何工作区资源`
  }
  if (tool.name === "bash" && !allowed.includes("workspace:**")) {
    return "TaskContract 使用受限资源时禁止执行无法静态证明路径边界的命令"
  }
  const targets = rawTargets.map((target) => normalizeCapabilityTarget(target, capability.workingDir))
  if (targets.some((target) => target === "*" || target.startsWith("external:")
    || !allowed.some((pattern) => resourceWithinCapability(target, pattern)))) {
    return `工具目标 ${rawTargets.join(", ")} 超出 TaskContract ${writes ? "writes" : "reads"} 能力边界`
  }
  return null
}

function normalizeCapabilityTarget(target: string, workingDir: string): string {
  if (!target || target === "*") return "*"
  const normalized = target.replace(/\\/g, "/")
  const path = relative(resolve(workingDir), resolve(workingDir, normalized)).replace(/\\/g, "/").toLowerCase()
  return path && !path.startsWith("../") ? path : `external:${normalized.toLowerCase()}`
}

function resourceWithinCapability(target: string, pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").toLowerCase()
  if (normalized === "workspace:**") return !target.startsWith("external:")
  if (normalized.startsWith("external:")) return target === normalized
  return matchesPattern(target, normalized)
    || target === normalized
    || target.startsWith(`${normalized}/`)
}

function policyMode(policy: RuntimeToolPolicy | undefined, effects: readonly ToolEffect[], toolName?: string): ToolPolicyMode {
  if (!policy) return "allow"
  const modes: ToolPolicyMode[] = []
  const communityKey = toolName ? COMMUNITY_POLICY_BY_TOOL[toolName] : undefined
  if (communityKey) {
    if (!policy.communityAutomation?.enabled) return "deny"
    modes.push(policy.communityAutomation[communityKey])
  }
  if (effects.includes("hardware")) modes.push(policy.toolPolicies.hardware)
  if (effects.includes("network")) modes.push(policy.toolPolicies.network)
  if (effects.includes("process")) modes.push(policy.toolPolicies.terminal)
  if (effects.includes("workspace-write")) modes.push(policy.toolPolicies.fileWrite)
  if (modes.includes("deny")) return "deny"
  if (modes.includes("ask")) return "ask"
  return "allow"
}

function toolCategoryLabel(effects: readonly ToolEffect[]): string {
  const labels: string[] = []
  if (effects.includes("hardware")) labels.push("硬件")
  if (effects.includes("network")) labels.push("网络")
  if (effects.includes("process")) labels.push("终端")
  if (effects.includes("workspace-write")) labels.push("文件写入")
  return labels.join("/") || "工具"
}

function scopeAllows(tool: ToolDefinition, scope: ExecutionScope, effects: readonly ToolEffect[]): boolean {
  if (scope === "plan-mode") {
    if (COMMUNITY_WRITE_TOOLS.has(tool.name)) return false
    return READ_ONLY_PERMISSIONS.has(tool.permission)
      && !effects.some((effect) => ["workspace-write", "process", "hardware", "delegation"].includes(effect))
  }
  return true
}

function visibilityEffects(tool: ToolDefinition): readonly ToolEffect[] {
  const minimum = tool.contract.alwaysEffects
  if (!minimum || minimum.length === 0) return tool.contract.effects
  const allowed = new Set(tool.contract.effects)
  return [...new Set(minimum.filter((effect) => allowed.has(effect)))]
}

export function toolAuthorizationEffects(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): readonly ToolEffect[] {
  if (!tool.resolveAuthorizationEffects) return tool.contract.effects
  try {
    const allowed = new Set(tool.contract.effects)
    const minimum = visibilityEffects(tool)
    const resolved = tool.resolveAuthorizationEffects(input)
    if (!Array.isArray(resolved) || resolved.some((effect) => !allowed.has(effect))) {
      return tool.contract.effects
    }
    return [...new Set([...minimum, ...resolved])]
  } catch {
    return tool.contract.effects
  }
}

export function authorizationTargets(input: Record<string, unknown>, declared?: readonly string[]): string[] {
  const keys = [...new Set([
    ...(declared ?? []),
    "path", "paths", "projectDir", "outputDir", "firmwarePath", "file", "command",
  ])]
  const values = keys.flatMap((key) => {
    const value = input[key]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
    return typeof value === "string" ? [value] : []
  }).map((value) => value.trim().replace(/\\/g, "/")).filter(Boolean)
  return values.length > 0 ? [...new Set(values)] : ["*"]
}

/**
 * Convert one concrete tool invocation into the same resource namespace used
 * by the scheduler. Shell commands are intentionally treated as whole-
 * workspace operations because their filesystem effects cannot be proven from
 * argv text.
 */
export function toolInvocationResourceClaims(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  workingDir: string,
): ResourceClaims | undefined {
  const effects = toolAuthorizationEffects(tool, input)
  const reads = effects.includes("workspace-read")
  const writes = effects.includes("workspace-write")
  if (!reads && !writes) return undefined
  const rawTargets = tool.name === "bash"
    ? ["workspace:**"]
    : authorizationTargets(input, tool.contract.progress.targetParameters)
      .map((target) => target === "*" ? "workspace:**" : target)
  return normalizeResourceClaims({
    reads: reads && !writes ? rawTargets : [],
    writes: writes ? rawTargets : [],
  }, workingDir)
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern || pattern === "*") return true
  const doubleStar = "__EVAL_DOUBLE_STAR__"
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, doubleStar)
    .replace(/\*/g, "[^/]*")
    .replaceAll(doubleStar, ".*")
  return new RegExp(`^${escaped}$`, "i").test(value)
}

function canonicalPolicyTarget(target: string, workingDir?: string): string {
  if (!target || target === "*") return "*"
  const base = canonicalExistingPath(resolve(workingDir ?? process.cwd()))
  const absolute = canonicalExistingPath(isAbsolute(target) ? resolve(target) : resolve(base, target))
  const workspaceRelative = relative(base, absolute).replace(/\\/g, "/")
  if (workspaceRelative === "") return "."
  if (workspaceRelative === ".." || workspaceRelative.startsWith("../") || isAbsolute(workspaceRelative)) {
    return `external:${absolute.replace(/\\/g, "/").toLowerCase()}`
  }
  return workspaceRelative
}

/**
 * Resolve the deepest existing ancestor so a symlinked directory cannot make
 * a lexically in-workspace path escape an allowlisted subtree. The remaining
 * non-existent suffix is appended after the real path has been resolved.
 */
function canonicalExistingPath(path: string): string {
  let ancestor = path
  const suffix: string[] = []
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    suffix.unshift(ancestor.slice(parent.length).replace(/^[/\\]+/, ""))
    ancestor = parent
  }
  const realAncestor = existsSync(ancestor) ? realpathSync.native(ancestor) : ancestor
  return resolve(realAncestor, ...suffix)
}

function normalizePolicyPattern(pattern: string): string | null {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "")
  if (!normalized || normalized === "*") return normalized || null
  // Allowlist entries themselves must never contain parent traversal.
  if (normalized.split("/").includes("..")) return null
  return normalized
}

/**
 * Command patterns authorize one invocation, never a shell program. Reject
 * unquoted chaining, pipelines, redirection and command interpolation before
 * applying the configured glob. Quoted punctuation remains a normal argument;
 * PowerShell interpolation is rejected outside single quotes.
 */
function isSingleAllowlistedCommand(command: string): boolean {
  let quote: "single" | "double" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    const next = command[index + 1]
    if (quote === "single") {
      if (char === "'" && next === "'") {
        index += 1
      } else if (char === "'") {
        quote = null
      }
      continue
    }
    if (char === "`") return false
    if (char === "$" && (next === "(" || next === "{")) return false
    if (quote === "double") {
      if (char === '"') quote = null
      continue
    }
    if (char === "'") {
      quote = "single"
      continue
    }
    if (char === '"') {
      quote = "double"
      continue
    }
    if (";|&<>\r\n".includes(char)) return false
  }
  return quote === null
}
