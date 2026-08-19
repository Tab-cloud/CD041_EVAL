import { ConfigRepo } from "../store/repository"
import type { CommunityAutomationSettings, ExecutionScope, ToolPolicyMode, ToolPolicySettings } from "./tool-policy"
import { DEFAULT_EXECUTION_BUDGET_POLICY, normalizeExecutionBudgetPolicy, type ExecutionBudgetPolicy } from "./execution-budget.ts"

export type SearchProviderId = "auto" | "duckduckgo" | "bing" | "google-news"

export interface AgentModelRoute {
  primaryModelId: string
  fallbackModelIds: string[]
}

export interface SystemSettings {
  theme: "dark" | "light"
  language: "zh-CN" | "en-US"
  restoreLastSession: boolean
  defaultWorkspace: string
  defaultScope: ExecutionScope
  defaultEffort: "on" | "off"
  webSearchEnabled: boolean
  workspaceIndexing: boolean
  autoOpenOutput: boolean
  serialBaudRate: number
  credentialRotationDays: number
  toolPolicies: ToolPolicySettings
  communityAutomation: CommunityAutomationSettings
  writePathAllowlist: string[]
  commandAllowlist: string[]
  searchProvider: SearchProviderId
  searchTimeoutMs: number
  searchMaxResults: number
  defaultModelId: string
  modelFallbackEnabled: boolean
  preferredAgentId: string
  agentModelRoutes: Record<string, AgentModelRoute>
  disabledToolIds: string[]
  disabledSkillIds: string[]
  executionBudget: ExecutionBudgetPolicy
}

const KEY = "system.settings"
const DEFAULTS: SystemSettings = {
  theme: "dark",
  language: "zh-CN",
  restoreLastSession: true,
  defaultWorkspace: "",
  defaultScope: "auto-edit",
  defaultEffort: "on",
  webSearchEnabled: true,
  workspaceIndexing: true,
  autoOpenOutput: false,
  serialBaudRate: 115200,
  credentialRotationDays: 90,
  toolPolicies: {
    fileWrite: "allow",
    terminal: "ask",
    network: "allow",
    hardware: "ask",
  },
  communityAutomation: {
    enabled: false,
    forumExplore: "deny",
    forumReply: "ask",
    forumCreateTopic: "ask",
    blogCreateDraft: "ask",
    blogPublish: "deny",
  },
  writePathAllowlist: [],
  commandAllowlist: [],
  searchProvider: "auto",
  searchTimeoutMs: 15000,
  searchMaxResults: 8,
  defaultModelId: "",
  modelFallbackEnabled: true,
  preferredAgentId: "",
  agentModelRoutes: {},
  disabledToolIds: [],
  disabledSkillIds: [],
  executionBudget: { ...DEFAULT_EXECUTION_BUDGET_POLICY },
}

export function getSystemSettings(): SystemSettings {
  try {
    return normalizeSystemSettings(JSON.parse(ConfigRepo.get(KEY) ?? "{}"))
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSystemSettings(value: unknown): SystemSettings {
  const settings = normalizeSystemSettings(value)
  ConfigRepo.set(KEY, JSON.stringify(settings))
  return settings
}

export interface SystemSettingReferences {
  modelIds?: ReadonlySet<string>
  agentIds?: ReadonlySet<string>
}

/** Remove references to deleted models or Agents without changing unrelated settings. */
export function reconcileSystemSettingsReferences(
  value: SystemSettings,
  references: SystemSettingReferences,
): SystemSettings {
  const modelExists = (id: string) => !references.modelIds || references.modelIds.has(id)
  const agentExists = (id: string) => !references.agentIds || references.agentIds.has(id)
  const routes: Record<string, AgentModelRoute> = {}
  for (const [agentId, route] of Object.entries(value.agentModelRoutes)) {
    if (!agentExists(agentId)) continue
    const primaryModelId = modelExists(route.primaryModelId) ? route.primaryModelId : ""
    const fallbackModelIds = route.fallbackModelIds.filter(modelExists).filter((id) => id !== primaryModelId)
    if (primaryModelId || fallbackModelIds.length) routes[agentId] = { primaryModelId, fallbackModelIds }
  }
  return normalizeSystemSettings({
    ...value,
    defaultModelId: modelExists(value.defaultModelId) ? value.defaultModelId : "",
    preferredAgentId: agentExists(value.preferredAgentId) ? value.preferredAgentId : "",
    agentModelRoutes: routes,
  })
}

export function normalizeSystemSettings(value: unknown): SystemSettings {
  const input = value && typeof value === "object" ? value as Partial<SystemSettings> : {}
  const scopes: ExecutionScope[] = ["confirm-changes", "auto-edit", "plan-mode", "full-access"]
  const baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
  const policyModes: ToolPolicyMode[] = ["allow", "ask", "deny"]
  const rawPolicies: Partial<ToolPolicySettings> = input.toolPolicies && typeof input.toolPolicies === "object" ? input.toolPolicies : {}
  const rawCommunity: Partial<CommunityAutomationSettings> = input.communityAutomation && typeof input.communityAutomation === "object" ? input.communityAutomation : {}
  const policy = (value: unknown, fallback: ToolPolicyMode): ToolPolicyMode =>
    policyModes.includes(value as ToolPolicyMode) ? value as ToolPolicyMode : fallback
  const patterns = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().replace(/\\/g, "/")).filter(Boolean).slice(0, 30).map((item) => item.slice(0, 500))
    : []
  const providers: SearchProviderId[] = ["auto", "duckduckgo", "bing", "google-news"]
  const normalizeId = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : ""
  const capabilityIds = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(item)).slice(0, 500))]
    : []
  const agentModelRoutes: Record<string, AgentModelRoute> = {}
  if (input.agentModelRoutes && typeof input.agentModelRoutes === "object") {
    for (const [agentId, rawRoute] of Object.entries(input.agentModelRoutes).slice(0, 50)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId) || !rawRoute || typeof rawRoute !== "object") continue
      const route = rawRoute as Partial<AgentModelRoute>
      const primaryModelId = typeof route.primaryModelId === "string" ? route.primaryModelId.slice(0, 600) : ""
      const fallbackModelIds = Array.isArray(route.fallbackModelIds)
        ? [...new Set(route.fallbackModelIds.filter((id): id is string => typeof id === "string").map((id) => id.slice(0, 600)).filter((id) => Boolean(id) && id !== primaryModelId))].slice(0, 5)
        : []
      if (primaryModelId || fallbackModelIds.length > 0) agentModelRoutes[agentId] = { primaryModelId, fallbackModelIds }
    }
  }
  return {
    theme: input.theme === "light" ? "light" : "dark",
    language: input.language === "en-US" ? "en-US" : "zh-CN",
    restoreLastSession: input.restoreLastSession !== false,
    defaultWorkspace: typeof input.defaultWorkspace === "string" ? input.defaultWorkspace.slice(0, 1000) : "",
    defaultScope: scopes.includes(input.defaultScope as ExecutionScope) ? input.defaultScope as ExecutionScope : "auto-edit",
    defaultEffort: input.defaultEffort === "off" ? "off" : "on",
    webSearchEnabled: input.webSearchEnabled !== false,
    workspaceIndexing: input.workspaceIndexing !== false,
    autoOpenOutput: input.autoOpenOutput === true,
    serialBaudRate: baudRates.includes(Number(input.serialBaudRate)) ? Number(input.serialBaudRate) : 115200,
    credentialRotationDays: [30, 60, 90, 180, 365].includes(Number(input.credentialRotationDays)) ? Number(input.credentialRotationDays) : 90,
    toolPolicies: {
      fileWrite: policy(rawPolicies.fileWrite, "allow"),
      terminal: policy(rawPolicies.terminal, "ask"),
      network: policy(rawPolicies.network, "allow"),
      hardware: policy(rawPolicies.hardware, "ask"),
    },
    communityAutomation: {
      enabled: rawCommunity.enabled === true,
      forumExplore: policy(rawCommunity.forumExplore, "deny"),
      forumReply: policy(rawCommunity.forumReply, "ask"),
      forumCreateTopic: policy(rawCommunity.forumCreateTopic, "ask"),
      blogCreateDraft: policy(rawCommunity.blogCreateDraft, "ask"),
      blogPublish: policy(rawCommunity.blogPublish, "deny"),
    },
    writePathAllowlist: patterns(input.writePathAllowlist),
    commandAllowlist: patterns(input.commandAllowlist),
    searchProvider: providers.includes(input.searchProvider as SearchProviderId) ? input.searchProvider as SearchProviderId : "auto",
    searchTimeoutMs: Math.min(30000, Math.max(3000, Number.isFinite(Number(input.searchTimeoutMs)) ? Math.round(Number(input.searchTimeoutMs)) : 15000)),
    searchMaxResults: Math.min(10, Math.max(1, Number.isFinite(Number(input.searchMaxResults)) ? Math.round(Number(input.searchMaxResults)) : 8)),
    defaultModelId: typeof input.defaultModelId === "string" ? input.defaultModelId.slice(0, 600) : "",
    modelFallbackEnabled: input.modelFallbackEnabled !== false,
    preferredAgentId: normalizeId(input.preferredAgentId),
    agentModelRoutes,
    disabledToolIds: capabilityIds(input.disabledToolIds),
    disabledSkillIds: capabilityIds(input.disabledSkillIds),
    executionBudget: normalizeExecutionBudgetPolicy(input.executionBudget),
  }
}
