import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { ConfigRepo } from "../store/repository"
import { getDb } from "../store/database"
import {
  getSystemSettings,
  normalizeSystemSettings,
  reconcileSystemSettingsReferences,
  type SystemSettingReferences,
  type SystemSettings,
} from "./system-settings"

export type ProjectSettingsOverrides = Partial<Pick<SystemSettings,
  | "defaultScope" | "defaultEffort" | "webSearchEnabled" | "workspaceIndexing"
  | "toolPolicies" | "writePathAllowlist" | "commandAllowlist"
  | "searchProvider" | "searchTimeoutMs" | "searchMaxResults"
  | "defaultModelId" | "modelFallbackEnabled" | "preferredAgentId" | "agentModelRoutes"
  | "disabledToolIds" | "disabledSkillIds"
  | "executionBudget"
>>

export interface ProjectSettingsRecord {
  projectPath: string
  overrides: ProjectSettingsOverrides
  updatedAt: number
}

const KEY_PREFIX = "project.settings."
const OVERRIDABLE_KEYS: Array<keyof ProjectSettingsOverrides> = [
  "defaultScope", "defaultEffort", "webSearchEnabled", "workspaceIndexing",
  "toolPolicies", "writePathAllowlist", "commandAllowlist",
  "searchProvider", "searchTimeoutMs", "searchMaxResults",
  "defaultModelId", "modelFallbackEnabled", "preferredAgentId", "agentModelRoutes",
  "disabledToolIds", "disabledSkillIds",
  "executionBudget",
]

export function getProjectSettings(projectPath: string): ProjectSettingsRecord | null {
  try {
    const raw = ConfigRepo.get(projectKey(projectPath))
    if (!raw) return null
    const parsed = JSON.parse(raw) as ProjectSettingsRecord
    return {
      projectPath: normalizedPath(projectPath),
      overrides: normalizeProjectOverrides(parsed.overrides),
      updatedAt: Number(parsed.updatedAt) || 0,
    }
  } catch {
    return null
  }
}

export function saveProjectSettings(projectPath: string, value: unknown): ProjectSettingsRecord {
  const record: ProjectSettingsRecord = {
    projectPath: normalizedPath(projectPath),
    overrides: normalizeProjectOverrides(value),
    updatedAt: Date.now(),
  }
  ConfigRepo.set(projectKey(projectPath), JSON.stringify(record))
  return record
}

export function deleteProjectSettings(projectPath: string): void {
  ConfigRepo.delete(projectKey(projectPath))
}

export function getEffectiveSystemSettings(projectPath?: string): SystemSettings {
  const global = getSystemSettings()
  if (!projectPath) return global
  const project = getProjectSettings(projectPath)
  return project ? mergeEffectiveSystemSettings(global, project.overrides) : global
}

/**
 * Project settings may specialize behaviour, but they are not a second
 * security authority. Global deny/ask rules, allowlists and disabled
 * capabilities remain hard upper bounds that a project cannot loosen.
 */
export function mergeEffectiveSystemSettings(
  global: SystemSettings,
  overrides: ProjectSettingsOverrides,
): SystemSettings {
  const project = normalizeSystemSettings({ ...global, ...overrides })
  const stricterPolicy = (globalMode: "allow" | "ask" | "deny", projectMode: "allow" | "ask" | "deny") => {
    const rank = { allow: 0, ask: 1, deny: 2 } as const
    return rank[globalMode] >= rank[projectMode] ? globalMode : projectMode
  }
  const hasOverride = <K extends keyof ProjectSettingsOverrides>(key: K): boolean => Object.hasOwn(overrides, key)
  return normalizeSystemSettings({
    ...project,
    webSearchEnabled: global.webSearchEnabled && project.webSearchEnabled,
    toolPolicies: {
      fileWrite: stricterPolicy(global.toolPolicies.fileWrite, project.toolPolicies.fileWrite),
      terminal: stricterPolicy(global.toolPolicies.terminal, project.toolPolicies.terminal),
      network: stricterPolicy(global.toolPolicies.network, project.toolPolicies.network),
      hardware: stricterPolicy(global.toolPolicies.hardware, project.toolPolicies.hardware),
    },
    // A non-empty global allowlist is an administrator boundary. Projects can
    // supply a list only when the global policy is unrestricted.
    writePathAllowlist: global.writePathAllowlist.length > 0
      ? global.writePathAllowlist
      : hasOverride("writePathAllowlist") ? project.writePathAllowlist : global.writePathAllowlist,
    commandAllowlist: global.commandAllowlist.length > 0
      ? global.commandAllowlist
      : hasOverride("commandAllowlist") ? project.commandAllowlist : global.commandAllowlist,
    disabledToolIds: [...new Set([...global.disabledToolIds, ...project.disabledToolIds])],
    disabledSkillIds: [...new Set([...global.disabledSkillIds, ...project.disabledSkillIds])],
  })
}

export function listProjectSettings(): ProjectSettingsRecord[] {
  return Object.entries(ConfigRepo.all()).filter(([key]) => key.startsWith(KEY_PREFIX)).flatMap(([, value]) => {
    try {
      const parsed = JSON.parse(value) as ProjectSettingsRecord
      return parsed.projectPath ? [{ ...parsed, overrides: normalizeProjectOverrides(parsed.overrides) }] : []
    } catch { return [] }
  })
}

export function importProjectSettings(records: unknown): number {
  if (!Array.isArray(records)) return 0
  const normalized: Array<{ projectPath: string; overrides: ProjectSettingsOverrides }> = []
  for (const item of records.slice(0, 200)) {
    if (!item || typeof item !== "object") continue
    const record = item as Partial<ProjectSettingsRecord>
    if (typeof record.projectPath !== "string" || !record.projectPath.trim()) continue
    normalized.push({ projectPath: record.projectPath, overrides: normalizeProjectOverrides(record.overrides) })
  }
  getDb().transaction(() => {
    for (const key of Object.keys(ConfigRepo.all()).filter((key) => key.startsWith(KEY_PREFIX))) ConfigRepo.delete(key)
    for (const record of normalized) saveProjectSettings(record.projectPath, record.overrides)
  })()
  return normalized.length
}

export function reconcileProjectSettingsReferences(references: SystemSettingReferences): void {
  const global = getSystemSettings()
  for (const record of listProjectSettings()) {
    const source = record.overrides
    const effective = reconcileSystemSettingsReferences(normalizeSystemSettings({ ...global, ...source }), references)
    const next: ProjectSettingsOverrides = { ...source }
    if (Object.hasOwn(source, "defaultModelId")) next.defaultModelId = effective.defaultModelId
    if (Object.hasOwn(source, "preferredAgentId")) next.preferredAgentId = effective.preferredAgentId
    if (Object.hasOwn(source, "agentModelRoutes")) next.agentModelRoutes = effective.agentModelRoutes
    if (JSON.stringify(next) !== JSON.stringify(source)) saveProjectSettings(record.projectPath, next)
  }
}

export function normalizeProjectOverrides(value: unknown): ProjectSettingsOverrides {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const normalized = normalizeSystemSettings({ ...getSystemSettings(), ...input })
  const result: ProjectSettingsOverrides = {}
  for (const key of OVERRIDABLE_KEYS) {
    if (Object.hasOwn(input, key)) (result as Record<string, unknown>)[key] = normalized[key]
  }
  return result
}

function projectKey(projectPath: string): string {
  return `${KEY_PREFIX}${createHash("sha256").update(normalizedPath(projectPath).toLowerCase()).digest("hex")}`
}

function normalizedPath(projectPath: string): string {
  return resolve(projectPath).replace(/\\/g, "/")
}
