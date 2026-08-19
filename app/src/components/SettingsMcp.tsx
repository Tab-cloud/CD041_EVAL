import { useCallback, useEffect, useState } from "react"
import { apiFetch } from "../api"
import { runCredentialTransaction, stageMcpCredentials, usesSystemCredentialStore } from "../model-credentials"
import { PlusIcon, RefreshCwIcon, StopIcon, TerminalIcon, Trash2Icon, ZapIcon } from "./Icons"

interface McpServer {
  id: string; name: string; transport: "stdio" | "http"; command?: string; args: string[]
  cwd?: string; url?: string; enabled: boolean; timeoutMs: number; startupTimeoutMs: number; toolTimeoutMs: number
  enabledTools: string[]; disabledTools: string[]; projectPath?: string
  status: "stopped" | "connecting" | "connected" | "error"; error?: string
  tools: Array<{ name: string; registeredName: string; description: string }>; resources: number; prompts: number
  instructions?: string; envKeys?: string[]; headerKeys?: string[]; securityWarnings?: string[]
}

interface Draft {
  id: string; name: string; transport: "stdio" | "http"; endpoint: string; args: string
  cwd: string; enabled: boolean; timeoutMs: number; startupTimeoutMs: number; toolTimeoutMs: number
  enabledTools: string; disabledTools: string; scope: "global" | "project"; env: string; headers: string
  envKeys: string[]; headerKeys: string[]
}

const EMPTY: Draft = {
  id: "", name: "", transport: "stdio", endpoint: "", args: "", cwd: "", enabled: true,
  timeoutMs: 30000, startupTimeoutMs: 30000, toolTimeoutMs: 60000, enabledTools: "", disabledTools: "",
  scope: "global", env: "", headers: "", envKeys: [], headerKeys: [],
}

export function SettingsMcp({ workspace }: { workspace: string | null }) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editingId, setEditingId] = useState("")
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiFetch("/api/mcp/servers")
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      setServers(data.servers ?? [])
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const edit = (server?: McpServer) => {
    setEditingId(server?.id ?? "")
    setDraft(server ? {
      id: server.id, name: server.name, transport: server.transport,
      endpoint: server.transport === "stdio" ? server.command ?? "" : server.url ?? "",
      args: server.args.join("\n"), cwd: server.cwd ?? "", enabled: server.enabled, timeoutMs: server.timeoutMs,
      startupTimeoutMs: server.startupTimeoutMs ?? server.timeoutMs,
      toolTimeoutMs: server.toolTimeoutMs ?? server.timeoutMs,
      enabledTools: (server.enabledTools ?? []).join("\n"), disabledTools: (server.disabledTools ?? []).join("\n"),
      scope: server.projectPath ? "project" : "global", env: "", headers: "",
      envKeys: server.envKeys ?? [], headerKeys: server.headerKeys ?? [],
    } : { ...EMPTY })
  }

  const saveList = async (next: Array<Record<string, unknown>>) => {
    const validation = await apiFetch("/api/mcp/validate", { method: "POST", body: JSON.stringify({ servers: next }) })
    const validationResult = await validation.json()
    if (!validation.ok) throw new Error(validationResult.error ?? `HTTP ${validation.status}`)
    await runCredentialTransaction(stageMcpCredentials(next), async () => {
      const response = await apiFetch("/api/mcp/servers", { method: "PUT", body: JSON.stringify({ servers: next }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
    })
    await load()
  }

  const saveDraft = async () => {
    if (!draft) return
    setLoading(true); setStatus("")
    try {
      if (!draft.id.trim() || !draft.name.trim() || !draft.endpoint.trim()) throw new Error("请填写 ID、名称和连接地址")
      const config: Record<string, unknown> = {
        id: draft.id, name: draft.name, transport: draft.transport,
        command: draft.transport === "stdio" ? draft.endpoint : undefined,
        url: draft.transport === "http" ? draft.endpoint : undefined,
        args: draft.args.split("\n").map((item) => item.trim()).filter(Boolean), cwd: draft.cwd || undefined,
        timeoutMs: draft.timeoutMs, startupTimeoutMs: draft.startupTimeoutMs, toolTimeoutMs: draft.toolTimeoutMs,
        enabledTools: lines(draft.enabledTools), disabledTools: lines(draft.disabledTools), enabled: draft.enabled,
        projectPath: draft.scope === "project" ? workspace : undefined,
      }
      if (draft.env.trim()) config.env = JSON.parse(draft.env)
      if (draft.headers.trim()) config.headers = JSON.parse(draft.headers)
      const next = servers.filter((item) => item.id !== editingId).map(stripRuntime).concat(config)
      await saveList(next); setDraft(null); setStatus("MCP 配置已保存")
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  const remove = async (id: string) => {
    setLoading(true); setStatus("")
    try { await saveList(servers.filter((item) => item.id !== id).map(stripRuntime)); setStatus("MCP 服务已删除") }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  const connect = async (server: McpServer, action: "start" | "stop") => {
    setLoading(true); setStatus("")
    try {
      const response = await apiFetch("/api/mcp/connect", { method: "POST", body: JSON.stringify({ id: server.id, action }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      await load()
      setStatus(action === "stop"
        ? "MCP 已停用；重启应用后仍保持停用"
        : data.server?.status === "connected"
          ? "MCP 已启用并连接"
          : `MCP 已启用，但连接失败：${data.server?.error ?? "未知错误"}`)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); await load() }
    finally { setLoading(false) }
  }

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>MCP 服务</h2><p>连接本地命令或 HTTP 服务。单个服务失败只会停用该集成，不会阻塞 Agent；服务指引会作为低信任上下文提供给对应工具。{usesSystemCredentialStore() ? "敏感值由 Windows 凭据管理器保护。" : ""}</p></div><div className="settings-title-actions"><button className="topbar-icon-btn" onClick={load} title="刷新"><RefreshCwIcon size={14} /></button><button className="topbar-icon-btn" onClick={() => edit()} title="添加 MCP"><PlusIcon size={14} /></button></div></div>
    <div className="settings-manage-list">
      {servers.map((server) => <div className="settings-manage-row" key={server.id}>
        <span className={`settings-status-dot ${server.status === "connected" ? "online" : ""}`} />
        <button className="settings-manage-main settings-text-button" onClick={() => edit(server)}><strong>{server.name}<small>{server.transport.toUpperCase()}</small>{Boolean(server.securityWarnings?.length) && <small className="settings-warning-badge">需修复</small>}</strong><span className={server.securityWarnings?.length ? "settings-warning-text" : ""}>{server.securityWarnings?.[0] ?? (server.status === "connected" ? `${server.tools.length} 工具 · ${server.resources} 资源 · ${server.prompts} Prompt` : server.error ?? (server.projectPath ? "项目服务" : "全局服务"))}</span></button>
        <div className="settings-row-actions">
          {server.enabled ? <button className="topbar-icon-btn" onClick={() => void connect(server, "stop")} title="停用"><StopIcon size={12} /></button> : <button className="topbar-icon-btn" disabled={Boolean(server.securityWarnings?.length)} onClick={() => void connect(server, "start")} title={server.securityWarnings?.length ? "请先移除明文凭据" : "启用并连接"}><ZapIcon size={13} /></button>}
          <button className="topbar-icon-btn" onClick={() => void remove(server.id)} title="删除"><Trash2Icon size={13} /></button>
        </div>
      </div>)}
      {!loading && servers.length === 0 && <div className="settings-empty-state">尚未配置 MCP 服务</div>}
    </div>
    {draft && <div className="settings-editor-panel">
      <div className="settings-editor-grid"><label><span>服务 ID</span><input disabled={Boolean(editingId)} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="filesystem" /></label><label><span>名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label></div>
      <div className="settings-toolbar-row"><div className="settings-segmented"><button className={draft.transport === "stdio" ? "active" : ""} onClick={() => setDraft({ ...draft, transport: "stdio" })}><TerminalIcon size={11} /> stdio</button><button className={draft.transport === "http" ? "active" : ""} onClick={() => setDraft({ ...draft, transport: "http" })}>HTTP</button></div><div className="settings-segmented"><button className={draft.scope === "global" ? "active" : ""} onClick={() => setDraft({ ...draft, scope: "global" })}>全局</button><button disabled={!workspace} className={draft.scope === "project" ? "active" : ""} onClick={() => setDraft({ ...draft, scope: "project" })}>项目</button></div></div>
      <label className="settings-editor-field"><span>{draft.transport === "stdio" ? "启动命令" : "服务 URL"}</span><input value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} placeholder={draft.transport === "stdio" ? "npx" : "http://127.0.0.1:3000/mcp"} /></label>
      <div className="settings-editor-grid"><label><span>启动与目录发现超时（毫秒）</span><input type="number" min={3000} max={120000} value={draft.startupTimeoutMs} onChange={(event) => setDraft({ ...draft, startupTimeoutMs: Number(event.target.value) || 30000 })} /></label><label><span>单次工具执行超时（毫秒）</span><input type="number" min={3000} max={600000} value={draft.toolTimeoutMs} onChange={(event) => setDraft({ ...draft, toolTimeoutMs: Number(event.target.value) || 60000 })} /></label></div>
      <div className="settings-editor-grid"><label><span>仅启用这些工具（每行一个；留空表示全部）</span><textarea value={draft.enabledTools} onChange={(event) => setDraft({ ...draft, enabledTools: event.target.value })} placeholder="read_file" /></label><label><span>禁用这些工具（每行一个；优先级更高）</span><textarea value={draft.disabledTools} onChange={(event) => setDraft({ ...draft, disabledTools: event.target.value })} placeholder="delete_file" /></label></div>
      {draft.transport === "stdio" && <div className="settings-editor-grid"><label><span>参数（每行一个）</span><textarea value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} /></label><label><span>环境变量 JSON（留空保持{draft.envKeys.length ? `，已保护 ${draft.envKeys.length} 项` : ""}）</span><textarea value={draft.env} onChange={(event) => setDraft({ ...draft, env: event.target.value })} placeholder={'{"KEY":"value"}；输入 {} 清空'} /></label></div>}
      {draft.transport === "http" && <label className="settings-editor-field"><span>请求头 JSON（留空保持{draft.headerKeys.length ? `，已保护 ${draft.headerKeys.length} 项` : ""}）</span><textarea value={draft.headers} onChange={(event) => setDraft({ ...draft, headers: event.target.value })} placeholder={'{"Authorization":"Bearer ..."}；输入 {} 清空'} /></label>}
      {editingId && servers.find((item) => item.id === editingId)?.instructions && <div className="settings-result-line">服务指引：{servers.find((item) => item.id === editingId)?.instructions}</div>}
      <div className="settings-inline-actions"><button className="btn btn-primary" onClick={saveDraft} disabled={loading}>保存配置</button><button className="btn btn-ghost" onClick={() => setDraft(null)}>取消</button></div>
    </div>}
    {status && <div className="settings-result-line">{status}</div>}
  </section>
}

function stripRuntime(server: McpServer): Record<string, unknown> {
  const { status: _status, error: _error, tools: _tools, resources: _resources, prompts: _prompts, instructions: _instructions, envKeys: _envKeys, headerKeys: _headerKeys, securityWarnings: _securityWarnings, ...config } = server
  return config
}

function lines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
}
