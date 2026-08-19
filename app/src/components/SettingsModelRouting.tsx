import { useEffect, useMemo, useState } from "react"
import { buildModelOptions, resolveModelOptionValue, type ModelOption } from "../model-options"
import type { AgentModelRoute, SystemSettings } from "../system-settings"
import type { AgentInfo, ModelConfig } from "../types"

interface Props {
  settings: SystemSettings
  models: ModelConfig[]
  agents: AgentInfo[]
  update: <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => void
  onOpenModels: () => void
}

export function SettingsModelRouting({ settings, models, agents, update, onOpenModels }: Props) {
  const options = useMemo(() => buildModelOptions(models), [models])
  const availableAgents = agents.filter((agent) => agent.mode !== "hidden")
  const [selectedAgent, setSelectedAgent] = useState(availableAgents[0]?.id ?? "")
  useEffect(() => {
    if (!availableAgents.some((agent) => agent.id === selectedAgent)) {
      setSelectedAgent(availableAgents[0]?.id ?? "")
    }
  }, [agents, selectedAgent])
  const route = settings.agentModelRoutes[selectedAgent] ?? { primaryModelId: "", fallbackModelIds: [] }
  const canonical = (value: string) => resolveModelOptionValue(options, value) || value
  const primaryModelId = canonical(route.primaryModelId)
  const fallbackModelIds = route.fallbackModelIds.map(canonical).slice(0, 2)
  const fallback1Options = options.filter((option) => option.id !== primaryModelId && option.id !== fallbackModelIds[1])
  const fallback2Options = options.filter((option) => option.id !== primaryModelId && option.id !== fallbackModelIds[0])

  const setRoute = (next: AgentModelRoute) => {
    const primary = canonical(next.primaryModelId)
    const fallbacks = next.fallbackModelIds.map(canonical)
    const normalized = {
      primaryModelId: primary,
      fallbackModelIds: fallbacks.filter((id, index, values) =>
        Boolean(id) && id !== primary && values.indexOf(id) === index).slice(0, 2),
    }
    const routes = { ...settings.agentModelRoutes }
    if (!normalized.primaryModelId && normalized.fallbackModelIds.length === 0) delete routes[selectedAgent]
    else routes[selectedAgent] = normalized
    update("agentModelRoutes", routes)
  }
  const setFallback = (index: number, modelId: string) => {
    const nextFallbacks = fallbackModelIds.slice(0, 2)
    if (index > 0 && !nextFallbacks[index - 1]) return
    if (modelId && nextFallbacks.some((id, currentIndex) => currentIndex !== index && id === modelId)) return
    if (modelId) nextFallbacks[index] = modelId
    else nextFallbacks.splice(index, 1)
    setRoute({ primaryModelId, fallbackModelIds: nextFallbacks })
  }

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>模型与路由</h2><p>{options.length} 个已启用模型</p></div><button className="btn btn-secondary" onClick={onOpenModels}>管理模型</button></div>
    <RouteRow title="全局默认模型" description="没有对话手动选择或 Agent 专属配置时使用。">
      <ModelSelect value={settings.defaultModelId} options={options} onChange={(value) => update("defaultModelId", value)} autoLabel="自动能力路由" />
    </RouteRow>
    <RouteRow title="失败时切换备用模型" description="按 Agent 主备链优先，否则自动选择能力兼容模型。">
      <Switch checked={settings.modelFallbackEnabled} onChange={(value) => update("modelFallbackEnabled", value)} />
    </RouteRow>
    <div className="settings-route-block">
      <div className="settings-route-heading"><div><strong>Agent 专属路由</strong><span>为不同任务指定主模型与有序备用链。</span></div>
        <select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}>{availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
      </div>
      {selectedAgent && <div className="settings-route-grid">
        <label><span>主模型</span><ModelSelect value={primaryModelId} options={options} onChange={(value) => setRoute({ primaryModelId: value, fallbackModelIds })} autoLabel="继承全局" /></label>
        <label><span>备用模型 1</span><ModelSelect value={fallbackModelIds[0] ?? ""} options={fallback1Options} onChange={(value) => setFallback(0, value)} autoLabel="自动选择" /></label>
        <label><span>备用模型 2</span><ModelSelect disabled={!fallbackModelIds[0] || fallback2Options.length === 0} value={fallbackModelIds[1] ?? ""} options={fallback2Options} onChange={(value) => setFallback(1, value)} autoLabel={!fallbackModelIds[0] ? "请先选择备用模型 1" : fallback2Options.length === 0 ? "没有其他可用模型" : "无"} /></label>
      </div>}
    </div>
    <div className="settings-model-list">
      {models.map((model) => {
        const enabledCount = options.filter((option) => option.configId === model.id).length
        return <div key={model.id}><span className={`settings-status-dot ${enabledCount > 0 ? "online" : ""}`} /><div><strong>{model.name}</strong><small>{model.provider} · {enabledCount}/{model.models?.length ?? 1} 个模型已启用</small></div><span>{enabledCount > 0 ? "已启用" : "已停用"}</span></div>
      })}
      {models.length === 0 && <div className="settings-empty">尚未配置模型</div>}
    </div>
  </section>
}

function ModelSelect({ value, options, onChange, autoLabel, disabled = false }: { value: string; options: ModelOption[]; onChange: (value: string) => void; autoLabel: string; disabled?: boolean }) {
  return <select disabled={disabled} value={resolveModelOptionValue(options, value)} onChange={(event) => onChange(event.target.value)}><option value="">{autoLabel}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
}

function RouteRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-control">{children}</div></div>
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <button className={`settings-switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>
}
