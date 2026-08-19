import { useState } from "react"
import type { Capability, ModelConfig, ModelVariantConfig } from "../types"
import { apiFetch } from "../api"
import { usesSystemCredentialStore } from "../model-credentials"
import {
  defaultOutputTokens,
  normalizeModelConfigsForEditor,
  serializeModelConfigs,
  setModelVariantEnabled,
  setProviderEnabled,
} from "../model-config-state"
import { BrainIcon, Code2Icon, EyeIcon, MessageSquareIcon, PlusIcon, RefreshCwIcon, SearchIcon, Trash2Icon, XIcon } from "./Icons"

const CAPS: Array<{ id: Capability; label: string; Icon: typeof EyeIcon }> = [
  { id: "vision", label: "视觉", Icon: EyeIcon },
  { id: "reasoning", label: "推理", Icon: BrainIcon },
  { id: "coding", label: "编码", Icon: Code2Icon },
  { id: "search", label: "搜索", Icon: SearchIcon },
  { id: "chat", label: "对话", Icon: MessageSquareIcon },
]

interface Props {
  configs: ModelConfig[]
  onUpdate: (configs: ModelConfig[]) => Promise<void>
  onClose: () => void
}

interface TestResult {
  key: string
  status: "idle" | "testing" | "ok" | "fail"
  reply?: string
  error?: string
  elapsedMs?: number
  toolProtocol?: {
    status: "verified" | "unsupported" | "unknown"
    error?: string
  }
}

export function ModelConfigModal({ configs, onUpdate, onClose }: Props) {
  const [local, setLocal] = useState<ModelConfig[]>(() => normalizeModelConfigsForEditor(configs.length ? configs : [createProvider()]))
  const [testResult, setTestResult] = useState<TestResult>({ key: "", status: "idle" })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")

  const updateProvider = (id: string, fields: Partial<ModelConfig>) => {
    setLocal((current) => current.map((config) => config.id === id ? { ...config, ...fields } : config))
  }
  const updateVariant = (configId: string, variantId: string, fields: Partial<ModelVariantConfig>) => {
    setLocal((current) => current.map((config) => config.id === configId ? {
      ...config,
      models: config.models?.map((variant) => variant.id === variantId ? { ...variant, ...fields } : variant),
    } : config))
  }
  const toggleCapability = (configId: string, variant: ModelVariantConfig, capability: Capability) => {
    updateVariant(configId, variant.id, {
      capabilities: variant.capabilities.includes(capability)
        ? variant.capabilities.filter((item) => item !== capability)
        : [...variant.capabilities, capability],
    })
  }
  const addVariant = (configId: string) => {
    setLocal((current) => current.map((config) => config.id === configId
      ? { ...config, models: [...(config.models ?? []), createVariant()] }
      : config))
  }
  const removeVariant = (configId: string, variantId: string) => {
    setLocal((current) => current.map((config) => config.id === configId
      ? { ...config, models: config.models?.filter((variant) => variant.id !== variantId) }
      : config))
  }

  const test = async (config: ModelConfig, variant: ModelVariantConfig) => {
    const key = `${config.id}:${variant.id}`
    setTestResult({ key, status: "testing" })
    try {
      const response = await apiFetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: variant.modelId,
          name: variant.name,
          provider: config.provider,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          clearApiKey: config.clearApiKey,
        }),
      })
      const data = await response.json().catch(() => ({}))
      setTestResult({
        key, status: response.ok && data.ok ? "ok" : "fail",
        reply: data.reply,
        error: data.error || (!response.ok ? `HTTP ${response.status}` : undefined),
        elapsedMs: data.elapsedMs,
        toolProtocol: data.toolProtocol,
      })
    } catch (error) {
      setTestResult({ key, status: "fail", error: error instanceof Error ? error.message : String(error) })
    }
  }

  const save = async () => {
    setSaving(true); setSaveError("")
    try {
      if (local.some((config) => !config.models?.length)) throw new Error("每个供应商至少需要一个模型")
      if (local.some((config) => config.models?.some((variant) => !variant.name.trim() || !variant.modelId.trim()))) {
        throw new Error("模型名称和模型 ID 不能为空")
      }
      if (local.some((config) => config.models?.some((variant) => variant.capabilities.length === 0))) {
        throw new Error("每个模型至少需要选择一项能力")
      }
      if (local.some((config) => config.models?.some((variant) => !Number.isInteger(variant.priority) || variant.priority < 1 || variant.priority > 100))) {
        throw new Error("路由顺序必须是 1 到 100 的整数，1 为最高")
      }
      if (local.some((config) => config.models?.some((variant) => !Number.isInteger(variant.contextWindow) || variant.contextWindow < 2_048 || variant.contextWindow > 10_000_000))) {
        throw new Error("上下文窗口必须是 2,048 到 10,000,000 的整数")
      }
      if (local.some((config) => config.models?.some((variant) => !Number.isInteger(variant.maxOutputTokens)
        || variant.maxOutputTokens < 512
        || variant.maxOutputTokens > maximumOutputTokens(variant.contextWindow)))) {
        throw new Error("最大输出必须至少为 512，并为上下文保留输入与安全空间")
      }
      if (local.some((config) => config.models?.some((variant) => !Number.isFinite(variant.costFactor) || variant.costFactor < 0.1 || variant.costFactor > 100))) {
        throw new Error("相对成本必须在 0.1 到 100 之间")
      }
      if (local.some((config) => {
        const ids = config.models?.map((variant) => variant.modelId.trim()) ?? []
        return new Set(ids).size !== ids.length
      })) throw new Error("同一供应商内不能配置重复的模型 ID")
      await onUpdate(serializeModelConfigs(local))
      onClose()
    } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }

  return <div className="modal-overlay"><div className="modal model-config-modal">
    <div className="modal-header"><span>模型配置</span><button className="btn btn-ghost btn-sm" onClick={onClose} title="关闭"><XIcon size={14} /></button></div>
    <div className="modal-body">
      <p className="model-config-intro">供应商开关是父级总开关：关闭后，其下所有模型都会关闭；重新开启后，请按需逐个启用模型。每个模型独立参与自动路由和备用链。
        {usesSystemCredentialStore() ? " 密钥由 Windows 凭据管理器保护。" : " 当前为开发模式，密钥由本地服务管理。"}</p>
      {local.map((config) => <section className={`model-provider-card ${config.enabled ? "" : "provider-paused"}`} key={config.id}>
        <div className="model-provider-head">
          <input className="input-field" value={config.name} onChange={(event) => updateProvider(config.id, { name: event.target.value })} placeholder="供应商配置名称" />
          <select className="select-field" value={config.provider} onChange={(event) => updateProvider(config.id, { provider: event.target.value })}>
            <option value="openai">OpenAI</option><option value="anthropic">Anthropic</option>
            <option value="openai-compatible">兼容 OpenAI</option><option value="local">本地 (Ollama)</option>
          </select>
          <div className="model-switch-control">
            <span>{config.enabled ? "供应商已启用" : "供应商已停用"}</span>
            <button className={`settings-switch ${config.enabled ? "on" : ""}`} role="switch" aria-label={`${config.name}供应商`} aria-checked={config.enabled} onClick={() => setLocal((current) => setProviderEnabled(current, config.id, !config.enabled))} title={config.enabled ? "关闭供应商并同时关闭其全部模型" : "开启供应商；模型仍需逐个启用"}><span /></button>
          </div>
          <button className="btn btn-ghost btn-sm danger" onClick={() => setLocal((current) => current.filter((item) => item.id !== config.id))} title="删除供应商"><Trash2Icon size={12} /></button>
        </div>
        <input className="input-field" value={config.baseUrl ?? ""} onChange={(event) => updateProvider(config.id, { baseUrl: event.target.value })} placeholder="Base URL（API 地址）" />
        <input className="input-field" type="password" value={config.apiKey ?? ""} onChange={(event) => updateProvider(config.id, { apiKey: event.target.value, clearApiKey: false })}
          placeholder={config.clearApiKey ? "密钥将在保存后清除" : config.hasApiKey ? "API Key 已保存（输入新值可覆盖）" : "API Key（留空使用环境变量）"} />
        {(config.hasApiKey || config.clearApiKey) && <div className="model-key-status"><span>{config.clearApiKey ? "已标记清除" : "系统密钥已配置"}</span>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => updateProvider(config.id, { apiKey: "", clearApiKey: !config.clearApiKey })}>
            {config.clearApiKey ? <><RefreshCwIcon size={11} />撤销</> : <><Trash2Icon size={11} />清除密钥</>}
          </button></div>}

        <fieldset className="model-variant-fieldset" disabled={!config.enabled} aria-label={`${config.name}模型配置`}>
        <div className="model-variant-list">
          {(config.models ?? []).map((variant) => {
            const key = `${config.id}:${variant.id}`
            return <div className="model-variant-card" key={variant.id}>
              <div className="model-variant-head">
                <input className="input-field" value={variant.name} onChange={(event) => updateVariant(config.id, variant.id, { name: event.target.value })} placeholder="显示名称" />
                <input className="input-field model-id-input" value={variant.modelId} onChange={(event) => updateVariant(config.id, variant.id, { modelId: event.target.value })} placeholder="模型 ID" />
                <div className="model-switch-control model-switch-control-compact">
                  <span>{variant.enabled ? "参与路由" : "不参与路由"}</span>
                  <button className={`settings-switch ${variant.enabled ? "on" : ""}`} role="switch" aria-label={`${variant.name}参与自动路由`} aria-checked={variant.enabled} aria-disabled={!config.enabled} onClick={() => setLocal((current) => setModelVariantEnabled(current, config.id, variant.id, !variant.enabled))} title={config.enabled ? (variant.enabled ? "从自动路由和备用链中移除" : "加入自动路由和备用链") : "请先开启供应商"}><span /></button>
                </div>
                <button className="btn btn-ghost btn-sm danger" disabled={(config.models?.length ?? 0) <= 1} onClick={() => removeVariant(config.id, variant.id)} title="删除模型"><XIcon size={12} /></button>
              </div>
              <div className="model-advanced-row">
                <label title="先比较能力匹配，再按该顺序选择；数值越小越优先"><span>路由顺序（1 最高）</span><input className="input-field" type="number" min={1} max={100} step={1} value={variant.priority} onChange={(event) => updateVariant(config.id, variant.id, { priority: Number(event.target.value) })} /></label>
                <label title="模型声明的输入与输出总窗口；用于历史压缩和请求预算"><span>上下文窗口（token）</span><input className="input-field" type="number" min={2_048} max={10_000_000} step={1024} value={variant.contextWindow} onChange={(event) => updateVariant(config.id, variant.id, { contextWindow: Number(event.target.value) })} /></label>
                <label title="独立传入真实模型请求，不再从上下文窗口推导"><span>最大输出（token）</span><input className="input-field" type="number" min={512} max={maximumOutputTokens(variant.contextWindow)} step={512} value={variant.maxOutputTokens} onChange={(event) => updateVariant(config.id, variant.id, { maxOutputTokens: Number(event.target.value) })} /></label>
                <label title="相同能力和路由顺序时用于比较；1 为基准，数值越低越优先"><span>相对成本（1 为基准）</span><input className="input-field" type="number" min={0.1} max={100} step={0.1} value={variant.costFactor} onChange={(event) => updateVariant(config.id, variant.id, { costFactor: Number(event.target.value) })} /></label>
              </div>
              <div className="model-capability-hint">能力偏好：视觉是输入协议硬要求，其余标签用于择优，不会阻断任务。</div>
              <div className="cap-row"><div className="cap-list">{CAPS.map(({ id, label, Icon }) => <button key={id} className={`cap-tag ${variant.capabilities.includes(id) ? "active" : ""}`} onClick={() => toggleCapability(config.id, variant, id)}><Icon size={12} />{label}</button>)}</div>
                <button className="cap-test-btn" disabled={!variant.modelId.trim() || (testResult.key === key && testResult.status === "testing")} onClick={() => void test(config, variant)}>{testResult.key === key && testResult.status === "testing" ? "测试中..." : "测试连接"}</button></div>
              {testResult.key === key && testResult.status !== "idle" && testResult.status !== "testing" && <div className={`model-test-result ${testResult.status}`}>
                {testResult.status === "ok" ? "连接成功" : testResult.error || "连接失败"}{testResult.elapsedMs != null ? ` · ${testResult.elapsedMs}ms` : ""}{testResult.status === "ok" && testResult.reply ? ` · ${testResult.reply}` : ""}
                {testResult.status === "ok" && testResult.toolProtocol
                  ? ` · 原生工具协议：${testResult.toolProtocol.status === "verified"
                    ? "已验证"
                    : testResult.toolProtocol.status === "unsupported"
                      ? "不支持"
                      : "未确认"}`
                  : ""}
              </div>}
            </div>
          })}
        </div>
        <button className="btn btn-ghost btn-sm model-add-variant" onClick={() => addVariant(config.id)}><PlusIcon size={12} />添加模型</button>
        </fieldset>
      </section>)}
      <button className="btn btn-ghost btn-sm model-add-provider" onClick={() => setLocal((current) => [...current, createProvider()])}><PlusIcon size={12} />添加供应商配置</button>
    </div>
    <div className="modal-footer">{saveError && <span className="settings-error">{saveError}</span>}<button className="btn btn-ghost" onClick={onClose} disabled={saving}>取消</button><button className="btn btn-primary" onClick={() => void save()} disabled={saving || local.length === 0}>{saving ? "保存中..." : "保存"}</button></div>
  </div></div>
}

function createProvider(): ModelConfig {
  const variant = createVariant()
  return {
    id: `provider-${crypto.randomUUID()}`, name: "新供应商", provider: "openai-compatible",
    modelId: variant.modelId, apiKey: "", baseUrl: "", capabilities: variant.capabilities,
    priority: variant.priority, costFactor: variant.costFactor, enabled: true,
    contextWindow: variant.contextWindow, maxOutputTokens: variant.maxOutputTokens,
    models: [variant],
  }
}

function createVariant(): ModelVariantConfig {
  const contextWindow = 128_000
  return {
    id: `model-${crypto.randomUUID()}`, name: "新模型", modelId: "", capabilities: ["chat"],
    priority: 1, costFactor: 1, enabled: true, contextWindow,
    maxOutputTokens: defaultOutputTokens(contextWindow),
  }
}

function maximumOutputTokens(contextWindow: number): number {
  const window = Number.isFinite(contextWindow) ? Math.max(2_048, Math.floor(contextWindow)) : 128_000
  const safetyReserve = Math.max(512, Math.floor(window * 0.05))
  return Math.max(512, window - safetyReserve - 1_024)
}
