import type { EffortMode, ScopeMode } from "./components/chat-helpers"
import type { AppLanguage } from "./i18n"

export type ToolPolicyMode = "allow" | "ask" | "deny"
export type SearchProviderId = "auto" | "duckduckgo" | "bing" | "google-news"

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

export interface AgentModelRoute {
  primaryModelId: string
  fallbackModelIds: string[]
}

export interface ExecutionBudgetPolicy {
  totalDurationMs: number
  rootWindowMs: number
  maxRootWindows: number
  childLeaseMs: number
  parentReserveMs: number
  minimumChildLeaseMs: number
  maxStagnantSegments: number
  maxRevisions: number
  maxRecoveryStrategies: number
}

export interface SystemSettings {
  theme: "dark" | "light"
  language: AppLanguage
  restoreLastSession: boolean
  defaultWorkspace: string
  defaultScope: ScopeMode
  defaultEffort: EffortMode
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

export type ProjectSettingsOverrides = Partial<Pick<SystemSettings,
  | "defaultScope" | "defaultEffort" | "webSearchEnabled" | "workspaceIndexing"
  | "toolPolicies" | "writePathAllowlist" | "commandAllowlist"
  | "searchProvider" | "searchTimeoutMs" | "searchMaxResults"
  | "defaultModelId" | "modelFallbackEnabled" | "preferredAgentId" | "agentModelRoutes"
  | "disabledToolIds" | "disabledSkillIds"
  | "executionBudget"
>>

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
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
  toolPolicies: { fileWrite: "allow", terminal: "ask", network: "allow", hardware: "ask" },
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
  executionBudget: {
    totalDurationMs: 2 * 60 * 60_000,
    rootWindowMs: 30 * 60_000,
    maxRootWindows: 4,
    childLeaseMs: 8 * 60_000,
    parentReserveMs: 5 * 60_000,
    minimumChildLeaseMs: 30_000,
    maxStagnantSegments: 4,
    maxRevisions: 6,
    maxRecoveryStrategies: 8,
  },
}

const CACHE_KEY = "eval_system_settings"

export function loadCachedSystemSettings(): SystemSettings {
  try {
    return normalizeSystemSettings(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}"))
  } catch {
    return { ...DEFAULT_SYSTEM_SETTINGS }
  }
}

export function cacheSystemSettings(settings: SystemSettings): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(settings)) } catch {}
}

export function normalizeSystemSettings(value: unknown): SystemSettings {
  const input = value && typeof value === "object" ? value as Partial<SystemSettings> : {}
  const scopes: ScopeMode[] = ["confirm-changes", "auto-edit", "plan-mode", "full-access"]
  const baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
  const policyModes: ToolPolicyMode[] = ["allow", "ask", "deny"]
  const rawPolicies: Partial<ToolPolicySettings> = input.toolPolicies && typeof input.toolPolicies === "object" ? input.toolPolicies : {}
  const rawCommunity: Partial<CommunityAutomationSettings> = input.communityAutomation && typeof input.communityAutomation === "object" ? input.communityAutomation : {}
  const policy = (value: unknown, fallback: ToolPolicyMode): ToolPolicyMode => policyModes.includes(value as ToolPolicyMode) ? value as ToolPolicyMode : fallback
  const patterns = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().replace(/\\/g, "/")).filter(Boolean).slice(0, 30).map((item) => item.slice(0, 500))
    : []
  const providers: SearchProviderId[] = ["auto", "duckduckgo", "bing", "google-news"]
  const normalizeId = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : ""
  const capabilityIds = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(item)).slice(0, 500))]
    : []
  const rawBudget = input.executionBudget && typeof input.executionBudget === "object" ? input.executionBudget : DEFAULT_SYSTEM_SETTINGS.executionBudget
  const totalDurationMs = boundedInteger(rawBudget.totalDurationMs, 5 * 60_000, 24 * 60 * 60_000, DEFAULT_SYSTEM_SETTINGS.executionBudget.totalDurationMs)
  const rootWindowMs = boundedInteger(rawBudget.rootWindowMs, 5 * 60_000, totalDurationMs, Math.min(DEFAULT_SYSTEM_SETTINGS.executionBudget.rootWindowMs, totalDurationMs))
  const parentReserveMs = boundedInteger(rawBudget.parentReserveMs, 60_000, Math.floor(rootWindowMs / 2), Math.min(DEFAULT_SYSTEM_SETTINGS.executionBudget.parentReserveMs, Math.floor(rootWindowMs / 2)))
  const minimumChildLeaseMs = boundedInteger(rawBudget.minimumChildLeaseMs, 5_000, 5 * 60_000, DEFAULT_SYSTEM_SETTINGS.executionBudget.minimumChildLeaseMs)
  const maxChildLease = Math.max(minimumChildLeaseMs, rootWindowMs - parentReserveMs)
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
    defaultScope: scopes.includes(input.defaultScope as ScopeMode) ? input.defaultScope as ScopeMode : "auto-edit",
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
    executionBudget: {
      totalDurationMs,
      rootWindowMs,
      maxRootWindows: boundedInteger(rawBudget.maxRootWindows, 1, Math.max(1, Math.ceil(totalDurationMs / rootWindowMs)), Math.min(DEFAULT_SYSTEM_SETTINGS.executionBudget.maxRootWindows, Math.max(1, Math.ceil(totalDurationMs / rootWindowMs)))),
      childLeaseMs: boundedInteger(rawBudget.childLeaseMs, minimumChildLeaseMs, maxChildLease, Math.min(DEFAULT_SYSTEM_SETTINGS.executionBudget.childLeaseMs, maxChildLease)),
      parentReserveMs,
      minimumChildLeaseMs,
      maxStagnantSegments: boundedInteger(
        rawBudget.maxStagnantSegments,
        0,
        20,
        DEFAULT_SYSTEM_SETTINGS.executionBudget.maxStagnantSegments,
      ),
      maxRevisions: boundedInteger(rawBudget.maxRevisions, 0, 50, DEFAULT_SYSTEM_SETTINGS.executionBudget.maxRevisions),
      maxRecoveryStrategies: boundedInteger(rawBudget.maxRecoveryStrategies, 1, 100, DEFAULT_SYSTEM_SETTINGS.executionBudget.maxRecoveryStrategies),
    },
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(number)))
}
