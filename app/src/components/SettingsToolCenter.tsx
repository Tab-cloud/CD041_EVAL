import { useCallback, useEffect, useMemo, useState } from "react"
import { apiFetch } from "../api"
import type { ProjectSettingsOverrides, SystemSettings } from "../system-settings"
import { RefreshCwIcon, SearchIcon, WrenchIcon } from "./Icons"

interface ToolItem {
  id: string; name: string; description: string; permission: string; category: string
  source: "builtin" | "mcp" | "plugin"; effects: string[]; idempotency: string; cancellation: string
  progress: { role: string; targetParameters?: string[]; verificationScope?: string }
  parameters: Record<string, unknown>; enabled: boolean; testable: boolean
  stats: { calls: number; succeeded: number; failed: number; averageLatencyMs: number; lastError?: string }
}

interface Props {
  settings: SystemSettings
  workspace: string | null
  update: <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => void
}

export function SettingsToolCenter({ settings, workspace, update }: Props) {
  const [tools, setTools] = useState<ToolItem[]>([])
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("全部")
  const [selectedId, setSelectedId] = useState("")
  const [testParams, setTestParams] = useState("{}")
  const [status, setStatus] = useState("")
  const [loading, setLoading] = useState(false)
  const [scope, setScope] = useState<"global" | "project">("global")
  const [projectOverrides, setProjectOverrides] = useState<ProjectSettingsOverrides>({})

  const load = useCallback(async () => {
    setLoading(true); setStatus("")
    try {
      const suffix = workspace ? `?projectPath=${encodeURIComponent(workspace)}` : ""
      const [toolsResponse, projectResponse] = await Promise.all([
        apiFetch(`/api/tools${suffix}`),
        workspace ? apiFetch(`/api/project-settings${suffix}`) : Promise.resolve(null),
      ])
      const data = await toolsResponse.json()
      if (!toolsResponse.ok) throw new Error(data.error ?? `HTTP ${toolsResponse.status}`)
      setTools(data.tools ?? [])
      if (projectResponse) {
        const projectData = await projectResponse.json()
        if (projectResponse.ok) setProjectOverrides(projectData.overrides ?? {})
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }, [workspace])

  useEffect(() => { void load() }, [load])
  const categories = useMemo(() => ["全部", ...new Set(tools.map((tool) => tool.category))], [tools])
  const selected = useMemo(() => tools.find((tool) => tool.id === selectedId) ?? null, [selectedId, tools])
  const visible = useMemo(() => tools.filter((tool) => (category === "全部" || tool.category === category)
    && `${tool.name} ${tool.id} ${tool.description}`.toLowerCase().includes(query.toLowerCase())), [tools, category, query])

  useEffect(() => {
    if (!workspace && scope === "project") setScope("global")
  }, [scope, workspace])
  useEffect(() => {
    if (!categories.includes(category)) setCategory("全部")
  }, [categories, category])

  const disabledForScope = scope === "global"
    ? settings.disabledToolIds
    : projectOverrides.disabledToolIds ?? settings.disabledToolIds

  const toggle = async (tool: ToolItem) => {
    const next = disabledForScope.includes(tool.id)
      ? disabledForScope.filter((id) => id !== tool.id) : [...disabledForScope, tool.id]
    if (scope === "global") { update("disabledToolIds", next); return }
    if (!workspace) return
    setLoading(true); setStatus("")
    try {
      const overrides = { ...projectOverrides, disabledToolIds: next }
      const response = await apiFetch("/api/project-settings", { method: "PUT", body: JSON.stringify({ projectPath: workspace, overrides }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      setProjectOverrides(data.overrides ?? overrides); setStatus("项目工具设置已保存")
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  const test = async () => {
    if (!selected) return
    setLoading(true); setStatus("")
    try {
      const params = JSON.parse(testParams)
      const response = await apiFetch("/api/tools/test", { method: "POST", body: JSON.stringify({ toolName: selected.id, params, projectPath: (workspace ?? settings.defaultWorkspace) || "." }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      setStatus(`测试成功：${JSON.stringify(data.result).slice(0, 240)}`)
      await load()
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>工具管理</h2><p>{tools.length} 个已注册工具，启停会同时影响模型可见性与执行授权。</p></div><button className="topbar-icon-btn" onClick={load} title="刷新"><RefreshCwIcon size={14} /></button></div>
    <div className="settings-toolbar-row">
      <label className="settings-search-box"><SearchIcon size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工具" /></label>
      <select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select>
      <div className="settings-segmented"><button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>全局</button><button disabled={!workspace} className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>项目</button></div>
    </div>
    <div className="settings-manage-list">
      {visible.map((tool) => {
        const enabled = !disabledForScope.includes(tool.id)
        const successRate = tool.stats.calls ? Math.round(tool.stats.succeeded / tool.stats.calls * 100) : 0
        return <button key={tool.id} className={`settings-manage-row ${selectedId === tool.id ? "selected" : ""}`} onClick={() => { setSelectedId(tool.id); setTestParams("{}") }}>
          <span className="settings-manage-icon"><WrenchIcon size={14} /></span><span className="settings-manage-main"><strong>{tool.name}<small>{tool.source === "builtin" ? "内置" : tool.source.toUpperCase()}</small></strong><span>{tool.description}</span></span>
          <span className="settings-manage-metric">{tool.stats.calls} 次<small>{tool.stats.calls ? `${successRate}% · ${tool.stats.averageLatencyMs}ms` : "暂无记录"}</small></span>
          <span className={`settings-switch ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled} onClick={(event) => { event.stopPropagation(); void toggle(tool) }}><span /></span>
        </button>
      })}
      {!loading && visible.length === 0 && <div className="settings-empty-state">没有匹配的工具</div>}
    </div>
    {selected && <div className="settings-detail-panel">
      <div><strong>{selected.id}</strong><span>{selected.permission} · {selected.category} · {progressLabel(selected.progress.role)}{selected.effects.length ? ` · ${selected.effects.join(" / ")}` : ""}</span></div>
      <details><summary>参数 Schema</summary><pre>{JSON.stringify(selected.parameters, null, 2)}</pre></details>
      {selected.stats.lastError && <p className="settings-detail-error">最近错误：{selected.stats.lastError}</p>}
      {selected.testable && <div className="settings-test-editor"><textarea value={testParams} onChange={(event) => setTestParams(event.target.value)} spellCheck={false} /><button className="btn btn-secondary" onClick={test} disabled={loading}>运行测试</button></div>}
    </div>}
    {status && <div className="settings-result-line">{status}</div>}
  </section>
}

function progressLabel(role: string): string {
  return ({ control: "控制", inspection: "检查", mutation: "变更", verification: "验证", delegation: "委派", dynamic: "动态" } as Record<string, string>)[role] ?? role
}
