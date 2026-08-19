import { useCallback, useEffect, useState } from "react"
import { apiFetch } from "../api"
import type { Capability } from "../types"
import { BotIcon, CopyIcon, PlusIcon, Trash2Icon } from "./Icons"

interface CustomAgent {
  id?: string; name: string; description: string; mode: "primary" | "subagent"
  requiredCapabilities: Capability[]; tools: string[]; systemPrompt: string
  maxSteps: number; temperature: number; color: string; projectPath?: string
}

interface ToolOption { id: string; name: string; category: string }

const EMPTY: CustomAgent = {
  name: "", description: "", mode: "subagent", requiredCapabilities: ["chat"], tools: [],
  systemPrompt: "", maxSteps: 15, temperature: 0.7, color: "#0ea5e9",
}
const CAPABILITIES: Capability[] = ["chat", "reasoning", "coding", "search", "vision"]

export function SettingsAgents({ workspace, onChanged }: { workspace: string | null; onChanged: () => Promise<void> }) {
  const [agents, setAgents] = useState<CustomAgent[]>([])
  const [tools, setTools] = useState<ToolOption[]>([])
  const [draft, setDraft] = useState<CustomAgent | null>(null)
  const [editingId, setEditingId] = useState("")
  const [toolQuery, setToolQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const suffix = workspace ? `?projectPath=${encodeURIComponent(workspace)}` : ""
      const [agentsResponse, toolsResponse] = await Promise.all([apiFetch("/api/custom-agents"), apiFetch(`/api/tools${suffix}`)])
      const agentsData = await agentsResponse.json(); const toolsData = await toolsResponse.json()
      if (!agentsResponse.ok) throw new Error(agentsData.error ?? `HTTP ${agentsResponse.status}`)
      if (!toolsResponse.ok) throw new Error(toolsData.error ?? `HTTP ${toolsResponse.status}`)
      setAgents(agentsData.agents ?? []); setTools(toolsData.tools ?? [])
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }, [workspace])
  useEffect(() => { void load() }, [load])

  const saveAll = async (next: CustomAgent[]) => {
    const response = await apiFetch("/api/custom-agents", { method: "PUT", body: JSON.stringify({ agents: next }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
    setAgents(data.agents ?? []); await onChanged()
  }

  const saveDraft = async () => {
    if (!draft) return
    setLoading(true); setStatus("")
    try {
      const next = agents.filter((agent) => agent.id !== editingId).concat({ ...draft, mode: "subagent" })
      await saveAll(next); setDraft(null); setStatus("自定义 Agent 已保存")
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  const remove = async (id?: string) => {
    if (!id) return
    setLoading(true); setStatus("")
    try { await saveAll(agents.filter((agent) => agent.id !== id)); setStatus("Agent 已删除") }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  const edit = (agent?: CustomAgent, copy = false) => {
    setEditingId(copy ? "" : agent?.id ?? "")
    setDraft(agent ? { ...agent, mode: "subagent", id: copy ? undefined : agent.id, name: copy ? `${agent.name} 副本` : agent.name, tools: [...agent.tools], requiredCapabilities: [...agent.requiredCapabilities] } : { ...EMPTY })
  }

  const toggleCapability = (capability: Capability) => {
    if (!draft) return
    const next = draft.requiredCapabilities.includes(capability)
      ? draft.requiredCapabilities.filter((item) => item !== capability) : [...draft.requiredCapabilities, capability]
    setDraft({ ...draft, requiredCapabilities: next.length ? next : ["chat"] })
  }
  const toggleTool = (id: string) => {
    if (!draft) return
    setDraft({ ...draft, tools: draft.tools.includes(id) ? draft.tools.filter((item) => item !== id) : [...draft.tools, id] })
  }
  const visibleTools = tools.filter((tool) => `${tool.name} ${tool.id} ${tool.category}`.toLowerCase().includes(toolQuery.toLowerCase()))

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>自定义 Agent</h2><p>主 Agent 始终负责会话与最终交付；这里创建可被主 Agent 委派的专业子 Agent，并配置其能力、工具白名单及项目作用域。</p></div><button className="topbar-icon-btn" onClick={() => edit()} title="新建 Agent"><PlusIcon size={14} /></button></div>
    <div className="settings-manage-list">
      {agents.map((agent) => <div className="settings-manage-row" key={agent.id}>
        <span className="settings-agent-color" style={{ background: agent.color }}><BotIcon size={13} /></span>
        <button className="settings-manage-main settings-text-button" onClick={() => edit(agent)}><strong>{agent.name}<small>专业子 Agent</small></strong><span>{agent.description} · {agent.tools.length} 个工具{agent.projectPath ? " · 项目" : " · 全局"}</span></button>
        <div className="settings-row-actions"><button className="topbar-icon-btn" onClick={() => edit(agent, true)} title="复制"><CopyIcon size={12} /></button><button className="topbar-icon-btn" onClick={() => void remove(agent.id)} title="删除"><Trash2Icon size={12} /></button></div>
      </div>)}
      {!loading && agents.length === 0 && <div className="settings-empty-state">尚未创建自定义 Agent</div>}
    </div>
    {draft && <div className="settings-editor-panel">
      <div className="settings-editor-grid"><label><span>名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>说明</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label></div>
      <div className="settings-toolbar-row"><span className="settings-result-line">角色：专业子 Agent</span><div className="settings-segmented"><button className={!draft.projectPath ? "active" : ""} onClick={() => setDraft({ ...draft, projectPath: undefined })}>全局</button><button disabled={!workspace} className={draft.projectPath ? "active" : ""} onClick={() => setDraft({ ...draft, projectPath: workspace ?? undefined })}>项目</button></div></div>
      <div className="settings-capability-row">{CAPABILITIES.map((capability) => <button key={capability} className={draft.requiredCapabilities.includes(capability) ? "active" : ""} onClick={() => toggleCapability(capability)}>{capability}</button>)}</div>
      <label className="settings-editor-field"><span>系统提示词</span><textarea value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} placeholder="定义职责、工作流程和输出约束" /></label>
      <div className="settings-tool-picker"><label><span>工具白名单（{draft.tools.length}）</span><input value={toolQuery} onChange={(event) => setToolQuery(event.target.value)} placeholder="筛选工具" /></label><div>{visibleTools.map((tool) => <button key={tool.id} className={draft.tools.includes(tool.id) ? "active" : ""} onClick={() => toggleTool(tool.id)}><span>{tool.name}</span><small>{tool.category}</small></button>)}</div></div>
      <div className="settings-editor-grid"><label><span>最大步数</span><input type="number" min="0" max="50" value={draft.maxSteps} onChange={(event) => setDraft({ ...draft, maxSteps: Number(event.target.value) })} /></label><label><span>温度</span><input type="number" min="0" max="2" step="0.1" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} /></label></div>
      <div className="settings-inline-actions"><button className="btn btn-primary" onClick={saveDraft} disabled={loading}>保存 Agent</button><button className="btn btn-ghost" onClick={() => setDraft(null)}>取消</button></div>
    </div>}
    {status && <div className="settings-result-line">{status}</div>}
  </section>
}
