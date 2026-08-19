import { useEffect, useMemo, useState } from "react"
import { apiFetch } from "../api"
import { buildModelOptions, resolveModelOptionValue } from "../model-options"
import type { ProjectSettingsOverrides, SystemSettings, ToolPolicySettings } from "../system-settings"
import type { AgentInfo, ModelConfig } from "../types"

interface Props {
  projectPath: string | null
  globalSettings: SystemSettings
  agents: AgentInfo[]
  models: ModelConfig[]
  onChanged: (effective: SystemSettings) => void
}

const POLICY_GROUPS: Array<{ key: keyof ToolPolicySettings; label: string }> = [
  { key: "fileWrite", label: "文件" }, { key: "terminal", label: "终端" },
  { key: "network", label: "网络" }, { key: "hardware", label: "硬件" },
]
const POLICY_RANK = { allow: 0, ask: 1, deny: 2 } as const

export function SettingsProject({ projectPath, globalSettings, agents, models, onChanged }: Props) {
  const [draft, setDraft] = useState<SystemSettings>(globalSettings)
  const [enabled, setEnabled] = useState(false)
  const [loadedOverrides, setLoadedOverrides] = useState<ProjectSettingsOverrides>({})
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState("")
  const modelOptions = useMemo(() => buildModelOptions(models), [models])

  useEffect(() => {
    if (!projectPath) { setDraft(globalSettings); setEnabled(false); setLoadedOverrides({}); return }
    let current = true
    setLoading(true)
    void apiFetch(`/api/project-settings?projectPath=${encodeURIComponent(projectPath)}`).then(async (response) => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      if (current) {
        setDraft(data.effective)
        setLoadedOverrides(data.overrides ?? {})
        setEnabled(Object.keys(data.overrides ?? {}).length > 0)
      }
    }).catch((error) => current && setStatus(error instanceof Error ? error.message : String(error))).finally(() => current && setLoading(false))
    return () => { current = false }
  }, [globalSettings, projectPath])

  const update = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => setDraft((previous) => ({ ...previous, [key]: value }))
  const save = async () => {
    if (!projectPath) return
    setLoading(true); setStatus("")
    try {
      if (!enabled) {
        const response = await apiFetch(`/api/project-settings?projectPath=${encodeURIComponent(projectPath)}`, { method: "DELETE" })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
        setDraft(data.effective); onChanged(data.effective); setStatus("已恢复全局设置")
      } else {
        const overrides: ProjectSettingsOverrides = { ...loadedOverrides,
          defaultScope: draft.defaultScope, defaultEffort: draft.defaultEffort,
          preferredAgentId: draft.preferredAgentId, defaultModelId: draft.defaultModelId,
          modelFallbackEnabled: draft.modelFallbackEnabled, workspaceIndexing: draft.workspaceIndexing,
          webSearchEnabled: draft.webSearchEnabled, toolPolicies: draft.toolPolicies,
        }
        const response = await apiFetch("/api/project-settings", { method: "PUT", body: JSON.stringify({ projectPath, overrides }) })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
        setDraft(data.effective); setLoadedOverrides(data.overrides ?? overrides); onChanged(data.effective); setStatus("项目设置已保存")
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  if (!projectPath) return <section className="settings-section"><h2>项目设置</h2><div className="settings-empty-state">选择工作空间后，可为项目配置独立的 Agent、模型和工具策略。</div></section>

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>项目设置</h2><p className="settings-project-path" title={projectPath}>{projectPath}</p><p>项目可调整工作方式并收紧权限，但不能放宽全局安全策略或重新启用全局禁用的能力。</p></div><Switch checked={enabled} onChange={setEnabled} /></div>
    <div className={!enabled ? "settings-disabled-block" : ""}>
      <ProjectRow title="默认 Agent" description="自动分派前优先使用该 Agent。"><select value={draft.preferredAgentId} onChange={(event) => update("preferredAgentId", event.target.value)}><option value="">自动分派</option>{agents.filter((agent) => agent.mode !== "hidden").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></ProjectRow>
      <ProjectRow title="默认模型" description="未手动指定模型时覆盖全局默认。"><select value={resolveModelOptionValue(modelOptions, draft.defaultModelId)} onChange={(event) => update("defaultModelId", event.target.value)}><option value="">自动路由</option>{modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></ProjectRow>
      <ProjectRow title="默认执行范围" description="新对话在该项目中的初始权限范围。"><select value={draft.defaultScope} onChange={(event) => update("defaultScope", event.target.value as SystemSettings["defaultScope"])}><option value="plan-mode">仅规划</option><option value="confirm-changes">变更前确认</option><option value="auto-edit">自动编辑</option><option value="full-access">完整访问</option></select></ProjectRow>
      <div className="settings-project-toggles"><Toggle label="模型失败回退" checked={draft.modelFallbackEnabled} onChange={(value) => update("modelFallbackEnabled", value)} /><Toggle label="联网检索" checked={draft.webSearchEnabled} disabled={!globalSettings.webSearchEnabled} onChange={(value) => update("webSearchEnabled", value)} /><Toggle label="语义索引" checked={draft.workspaceIndexing} onChange={(value) => update("workspaceIndexing", value)} /><Toggle label="默认思考" checked={draft.defaultEffort === "on"} onChange={(value) => update("defaultEffort", value ? "on" : "off")} /></div>
      <div className="settings-project-policy"><strong>项目工具策略</strong><div>{POLICY_GROUPS.map((group) => <label key={group.key}><span>{group.label}</span><select value={draft.toolPolicies[group.key]} onChange={(event) => update("toolPolicies", { ...draft.toolPolicies, [group.key]: event.target.value as ToolPolicySettings[typeof group.key] })}><option value="allow" disabled={POLICY_RANK.allow < POLICY_RANK[globalSettings.toolPolicies[group.key]]}>允许</option><option value="ask" disabled={POLICY_RANK.ask < POLICY_RANK[globalSettings.toolPolicies[group.key]]}>询问</option><option value="deny">禁止</option></select></label>)}</div></div>
    </div>
    <div className="settings-inline-actions"><button className="btn btn-secondary" disabled={loading} onClick={save}>{loading ? "保存中..." : enabled ? "保存项目设置" : "恢复全局设置"}</button>{status && <span>{status}</span>}</div>
  </section>
}

function ProjectRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-control">{children}</div></div> }
function Toggle({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) { return <label title={disabled ? "已被全局安全策略禁用" : undefined}><span>{label}</span><Switch checked={checked} disabled={disabled} onChange={onChange} /></label> }
function Switch({ checked, disabled = false, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) { return <button disabled={disabled} className={`settings-switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button> }
