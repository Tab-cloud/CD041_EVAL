/**
 * Config Store — LLM 配置持久化
 *
 * 读写 ~/.eval/eval_config.json，与 SQLite 同目录
 * - 加载/保存模型配置
 * - 导入/导出 JSON
 * - 模型目录完全由用户配置；运行时不绑定任何供应商 modelId
 */

import type { ModelConfig } from "../model-router/types"
import { normalizeModelOutputTokens } from "./model-limits.ts"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const CONFIG_FILE = "eval_config.json"

// ══════════════════════════════════════════════
// 预设模板
// ══════════════════════════════════════════════

/** Provider catalogs are external data. An empty catalog prevents stale model IDs from becoming runtime policy. */
export const PRESETS: Record<string, ModelConfig[]> = {}

// ══════════════════════════════════════════════
// Config Store
// ══════════════════════════════════════════════

export class ConfigStore {
  private configPath: string
  private cache: { configs: ModelConfig[]; mtime: number } | null = null
  private credentialMode: "file" | "external"
  private credentials: Map<string, string>

  constructor(baseDir?: string, options?: { credentialMode?: "file" | "external"; credentials?: Record<string, string> }) {
    const runtimeDataDir = process.env.EVAL_DATA_DIR?.trim()
    this.configPath = join(baseDir ?? (runtimeDataDir || join(homedir(), ".eval")), CONFIG_FILE)
    this.credentialMode = options?.credentialMode ?? (process.env.EVAL_CREDENTIAL_STORE === "external" ? "external" : "file")
    this.credentials = new Map(Object.entries(options?.credentials ?? readCredentialEnvironment()))
  }

  /** 加载模型配置 */
  load(): ModelConfig[] {
    try {
      const stat = existsSync(this.configPath) ? readFileSync(this.configPath, "utf-8") : null
      if (!stat) return this.withCredentials(this.defaults())

      // 缓存命中（文件未修改）
      const mtime = this.fileMtime()
      if (this.cache && this.cache.mtime === mtime) return this.cache.configs

      const data = JSON.parse(stat)
      const stored = normalizeModelConfigs(Array.isArray(data) ? data : data.models) ?? this.defaults()
      const configs = this.withCredentials(stored)
      this.cache = { configs, mtime }
      return configs
    } catch {
      return this.withCredentials(this.defaults())
    }
  }

  /** 保存模型配置 (原子写入——先写临时文件再改名，防止崩溃损坏) */
  save(configs: ModelConfig[], options?: { clearApiKeyIds?: Iterable<string> }): boolean {
    try {
      const validated = normalizeModelConfigs(configs)
      if (!validated) return false
      const cleared = new Set(options?.clearApiKeyIds ?? [])
      if (this.credentialMode === "external") {
        const retained = new Set(validated.map((model) => model.id))
        for (const id of this.credentials.keys()) if (!retained.has(id)) this.credentials.delete(id)
        for (const model of validated) {
          if (cleared.has(model.id)) this.credentials.delete(model.id)
          else if (model.apiKey) this.credentials.set(model.id, model.apiKey)
        }
      }
      const stored = this.credentialMode === "external"
        ? validated.map((model) => ({ ...model, apiKey: "" }))
        : validated
      mkdirSync(dirname(this.configPath), { recursive: true })
      const json = JSON.stringify(stored, null, 2) + "\n"
      const tmp = this.configPath + ".tmp"
      writeFileSync(tmp, json, { encoding: "utf-8", mode: 0o600 })
      // 原子 rename (Windows 上 renameSync 覆盖已存在的文件)
      try { renameSync(tmp, this.configPath) } catch { writeFileSync(this.configPath, json, "utf-8") }
      try { chmodSync(this.configPath, 0o600) } catch {}
      this.cache = { configs: this.withCredentials(stored), mtime: this.fileMtime() }
      return true
    } catch (err) {
      console.error("保存配置失败:", err)
      return false
    }
  }

  /** 导出为 JSON 字符串（屏蔽 apiKey，防止分享配置时泄露密钥） */
  export(configs: ModelConfig[]): string {
    const safe = configs.map((m) => ({ ...m, apiKey: "" }))
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), models: safe }, null, 2)
  }

  /** 从 JSON 字符串导入 */
  import(json: string): ModelConfig[] | null {
    try {
      const data = JSON.parse(json)
      const configs = data.models ?? data
      const validated = normalizeModelConfigs(configs)
      if (!validated || !this.save(validated)) return null
      return this.load()
    } catch {
      return null
    }
  }

  /** 应用预设模板（合并而非覆盖） */
  applyPreset(presetName: string, existing: ModelConfig[]): ModelConfig[] {
    const preset = PRESETS[presetName]
    if (!preset) return existing

    const merged = new Map<string, ModelConfig>()
    for (const m of existing) merged.set(m.id, m)
    for (const m of preset) merged.set(m.id, { ...m, apiKey: merged.get(m.id)?.apiKey ?? m.apiKey })
    return Array.from(merged.values())
  }

  /** 默认配置（首次使用） */
  private defaults(): ModelConfig[] {
    return []
  }

  private fileMtime(): number {
    try { return statSync(this.configPath).mtimeMs } catch { return 0 }
  }

  credentialBackend(): "file" | "external" {
    return this.credentialMode
  }

  setExternalCredentials(value: unknown): void {
    if (this.credentialMode !== "external") return
    this.credentials = new Map(Object.entries(normalizeCredentialRecord(value)))
    this.cache = null
  }

  private withCredentials(configs: ModelConfig[]): ModelConfig[] {
    if (this.credentialMode !== "external") return configs
    return configs.map((model) => ({ ...model, apiKey: this.credentials.get(model.id) ?? model.apiKey ?? "" }))
  }
}

export const configStore = new ConfigStore()

function readCredentialEnvironment(): Record<string, string> {
  try {
    return normalizeCredentialRecord(JSON.parse(process.env.EVAL_MODEL_CREDENTIALS ?? "{}"))
  } catch {
    return {}
  }
}

function normalizeCredentialRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const credentials: Record<string, string> = {}
  for (const [id, secret] of Object.entries(value)) {
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id) && typeof secret === "string" && secret.length <= 2_048) credentials[id] = secret
  }
  return credentials
}

const CAPABILITIES = new Set(["vision", "reasoning", "coding", "search", "chat"])

export function normalizeModelConfigs(value: unknown): ModelConfig[] | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const ids = new Set<string>()
  const result: ModelConfig[] = []
  let totalModels = 0
  for (const item of value) {
    if (!item || typeof item !== "object") return null
    const model = item as Record<string, unknown>
    if (typeof model.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(model.id) || ids.has(model.id)) return null
    if (typeof model.name !== "string" || !model.name.trim() || model.name.length > 100) return null
    if (typeof model.provider !== "string" || !model.provider.trim() || model.provider.length > 50) return null
    if (typeof model.modelId !== "string" || !model.modelId.trim() || model.modelId.length > 500) return null
    if (model.apiKey !== undefined && (typeof model.apiKey !== "string" || model.apiKey.length > 2_048)) return null
    if (model.baseUrl) {
      try {
        const url = new URL(String(model.baseUrl))
        if (url.protocol !== "http:" && url.protocol !== "https:") return null
      } catch { return null }
    }
    if (!Array.isArray(model.capabilities) || model.capabilities.length === 0 || model.capabilities.some((capability) => !CAPABILITIES.has(String(capability)))) return null
    if (!Number.isInteger(model.priority) || Number(model.priority) < 1 || Number(model.priority) > 100) return null
    if (!Number.isFinite(model.costFactor) || Number(model.costFactor) < 0.1 || Number(model.costFactor) > 100) return null
    if (typeof model.enabled !== "boolean") return null
    if (!Number.isInteger(model.contextWindow) || Number(model.contextWindow) < 2_048 || Number(model.contextWindow) > 10_000_000) return null
    const discoveredVariants = normalizeVariants(model)
    if (!discoveredVariants) return null
    // The provider is the authoritative parent gate. Normalize persisted,
    // imported and API-supplied configurations as well as the editor so a
    // disabled provider can never retain logically enabled child models.
    const variants = model.enabled
      ? discoveredVariants
      : discoveredVariants.map((variant) => ({ ...variant, enabled: false }))
    const primary = variants.find((variant) => variant.enabled) ?? variants[0]
    totalModels += variants.length
    if (totalModels > 200) return null
    ids.add(model.id)
    result.push({
      id: model.id,
      name: model.name.trim(),
      provider: model.provider.trim(),
      modelId: primary.modelId,
      apiKey: typeof model.apiKey === "string" ? model.apiKey : "",
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : "",
      capabilities: primary.capabilities,
      priority: primary.priority,
      costFactor: primary.costFactor,
      enabled: model.enabled,
      contextWindow: primary.contextWindow,
      maxOutputTokens: primary.maxOutputTokens,
      models: variants,
    })
  }
  return result
}

function normalizeVariants(model: Record<string, unknown>): NonNullable<ModelConfig["models"]> | null {
  if (model.models === undefined) {
    const contextWindow = Number(model.contextWindow)
    const maxOutputTokens = normalizeModelOutputTokens(contextWindow, model.maxOutputTokens)
    if (maxOutputTokens === null) return null
    const base = {
      capabilities: model.capabilities as ModelConfig["capabilities"],
      priority: Number(model.priority),
      costFactor: Number(model.costFactor),
      enabled: true,
      contextWindow,
      maxOutputTokens,
    }
    const concreteIds = String(model.modelId).split(",").map((id) => id.trim()).filter(Boolean)
    if (concreteIds.length === 0 || concreteIds.length > 50) return null
    return concreteIds.map((modelId, index) => ({
      id: index === 0 ? "default" : `model-${index + 1}`,
      name: concreteIds.length === 1 ? String(model.name).trim() : `${String(model.name).trim()} · ${modelId}`,
      modelId,
      ...base,
    }))
  }
  if (!Array.isArray(model.models) || model.models.length === 0 || model.models.length > 50) return null
  const variantIds = new Set<string>()
  const variants: NonNullable<ModelConfig["models"]> = []
  for (const item of model.models) {
    if (!item || typeof item !== "object") return null
    const variant = item as Record<string, unknown>
    if (typeof variant.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(variant.id) || variantIds.has(variant.id)) return null
    if (typeof variant.name !== "string" || !variant.name.trim() || variant.name.length > 100) return null
    if (typeof variant.modelId !== "string" || !variant.modelId.trim() || variant.modelId.length > 300 || variant.modelId.includes(",")) return null
    if (!Array.isArray(variant.capabilities) || variant.capabilities.length === 0 || variant.capabilities.some((capability) => !CAPABILITIES.has(String(capability)))) return null
    if (!Number.isInteger(variant.priority) || Number(variant.priority) < 1 || Number(variant.priority) > 100) return null
    if (!Number.isFinite(variant.costFactor) || Number(variant.costFactor) < 0.1 || Number(variant.costFactor) > 100) return null
    if (typeof variant.enabled !== "boolean") return null
    if (!Number.isInteger(variant.contextWindow) || Number(variant.contextWindow) < 2_048 || Number(variant.contextWindow) > 10_000_000) return null
    const contextWindow = Number(variant.contextWindow)
    const maxOutputTokens = normalizeModelOutputTokens(contextWindow, variant.maxOutputTokens)
    if (maxOutputTokens === null) return null
    variantIds.add(variant.id)
    variants.push({
      id: variant.id,
      name: variant.name.trim(),
      modelId: variant.modelId.trim(),
      capabilities: variant.capabilities as ModelConfig["capabilities"],
      priority: Number(variant.priority),
      costFactor: Number(variant.costFactor),
      enabled: variant.enabled,
      contextWindow,
      maxOutputTokens,
    })
  }
  return variants
}
