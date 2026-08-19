import { useCallback, useEffect, useState } from "react"
import { open, save } from "@tauri-apps/plugin-dialog"
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs"
import { apiFetch } from "../api"
import { getCredentialHealth, getSecurityAudit, type CredentialHealth, type SecurityAuditEntry } from "../model-credentials"
import type { SystemSettings } from "../system-settings"
import { ActivityIcon, DownloadIcon, RefreshCwIcon, ShieldIcon, UploadIcon } from "./Icons"

interface Diagnostics {
  generatedAt: string
  health: { tools: number; agents: number; models: number; scheduler: { running: number; queued: number; failed: number } }
  counts: { sessions: number; projects: number; projectOverrides: number; modelCalls: number; toolExecutions: number; tasks: number }
  usage: { totalCalls: number; totalPromptTokens: number; totalCompletionTokens: number; totalCost: number }
  errorRate: { total: number; errors: number; rate: number }
  calls: Array<{ id: string; modelName: string; agentId: string; latency: number; success: boolean; error?: string; routeReason?: string; routeAttempts?: Array<{ modelName: string; fallback: boolean }> ; timestamp: number }>
  tools: Array<{ id: string; toolName: string; status: string; error?: string; startedAt: number }>
}

export function SettingsDiagnostics({ settings, onRestored }: { settings: SystemSettings; onRestored: (settings: SystemSettings) => Promise<void> }) {
  const [data, setData] = useState<Diagnostics | null>(null)
  const [credentials, setCredentials] = useState<CredentialHealth | null>(null)
  const [audit, setAudit] = useState<SecurityAuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState("")

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [response, credentialHealth, auditEntries] = await Promise.all([
        apiFetch("/api/diagnostics"),
        getCredentialHealth(settings.credentialRotationDays).catch(() => null),
        getSecurityAudit(8).catch(() => []),
      ])
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      setData(payload)
      setCredentials(credentialHealth)
      setAudit(auditEntries)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }, [settings.credentialRotationDays])
  useEffect(() => { void refresh() }, [refresh])

  const exportJson = async (endpoint: string, prefix: string) => {
    setStatus("")
    try {
      const response = await apiFetch(endpoint)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      const path = await save({ defaultPath: `${prefix}-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] })
      if (!path) return
      await writeTextFile(path, JSON.stringify(payload, null, 2))
      setStatus("文件已导出")
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }

  const restore = async () => {
    setStatus("")
    try {
      const path = await open({ multiple: false, filters: [{ name: "Eval 配置备份", extensions: ["json"] }] })
      if (typeof path !== "string") return
      const backup = JSON.parse(await readTextFile(path))
      if (!window.confirm("恢复会覆盖全局设置、项目覆盖和模型配置，但会保留本机已有 API Key。是否继续？")) return
      const response = await apiFetch("/api/config/restore", { method: "POST", body: JSON.stringify(backup) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      await onRestored(payload.settings)
      setStatus(`恢复完成：${payload.modelCount} 个模型，${payload.projectCount} 个项目配置`)
      await refresh()
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }

  const exportAudit = async () => {
    setStatus("")
    try {
      const entries = await getSecurityAudit(100)
      const path = await save({ defaultPath: `eval-security-audit-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] })
      if (!path) return
      await writeTextFile(path, JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2))
      setStatus("安全审计已导出")
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>诊断与数据</h2><p>运行状态、模型路由、执行记录和配置迁移。</p></div><button className="topbar-icon-btn" onClick={refresh} disabled={loading} title="刷新"><RefreshCwIcon size={14} /></button></div>
    <div className="settings-diagnostic-grid">
      <Metric label="模型调用" value={String(data?.counts.modelCalls ?? "-")} detail={`${data?.errorRate.errors ?? 0} 次失败`} />
      <Metric label="Token" value={formatNumber((data?.usage.totalPromptTokens ?? 0) + (data?.usage.totalCompletionTokens ?? 0))} detail={`$${(data?.usage.totalCost ?? 0).toFixed(4)}`} />
      <Metric label="工具执行" value={String(data?.counts.toolExecutions ?? "-")} detail={`${data?.health.tools ?? 0} 个工具`} />
      <Metric label="任务" value={String(data?.counts.tasks ?? "-")} detail={`${data?.health.scheduler.running ?? 0} 运行 / ${data?.health.scheduler.queued ?? 0} 排队`} />
    </div>
    {credentials && <div className="settings-credential-health">
      <div className="settings-subheading"><strong><ShieldIcon size={13} />凭据安全</strong><span>{credentialBackend(credentials)} · {new Date(credentials.checkedAt).toLocaleTimeString()}</span></div>
      <div className="settings-credential-grid">
        <CredentialMetric label="模型密钥" value={String(credentials.modelCredentials)} detail={`${credentials.modelRecords} 个模型记录`} state={credentials.available ? "ok" : "error"} />
        <CredentialMetric label="MCP 凭据" value={`${credentials.mcpCredentials}/${credentials.mcpExpected}`} detail={credentials.mcpMissing ? `${credentials.mcpMissing} 项缺失` : "索引一致"} state={credentials.mcpMissing ? "error" : "ok"} />
        <CredentialMetric label="Webhook" value={credentials.webhookConfigured ? "已保护" : "未配置"} detail={credentials.readErrors ? `${credentials.readErrors} 个读取错误` : credentials.healthy ? "检查正常" : "需要检查"} state={credentials.readErrors ? "error" : credentials.healthy ? "ok" : "neutral"} />
        <CredentialMetric label="凭据轮换" value={credentials.rotationDue ? `${credentials.rotationDue} 项到期` : "正常"} detail={`${credentials.rotationDays} 天 · ${oldestCredentialLabel(credentials.oldestCredentialAt)}`} state={credentials.readErrors ? "error" : credentials.rotationDue ? "warning" : "ok"} />
      </div>
    </div>}
    <div className="settings-diagnostic-section"><div className="settings-subheading"><strong>最近安全事件</strong><span>{audit.length ? `${audit.length} 条` : ""}</span></div>
      <div className="settings-diagnostic-list">{audit.map((entry) => <div key={entry.id}><span className={`settings-status-dot ${entry.status === "success" ? "online" : "error"}`} /><div><strong>{auditEventLabel(entry.event)}</strong><small>{entry.detail}</small><p>{entry.status === "success" ? "操作完成" : "操作失败"}</p></div><time>{new Date(entry.createdAt).toLocaleString()}</time></div>)}{audit.length === 0 && <div className="settings-empty">暂无安全操作记录</div>}</div>
    </div>
    <div className="settings-diagnostic-section"><div className="settings-subheading"><strong>最近模型路由</strong><span>{data ? new Date(data.generatedAt).toLocaleTimeString() : ""}</span></div>
      <div className="settings-diagnostic-list">{data?.calls.slice(0, 5).map((call) => <div key={call.id}><span className={`settings-status-dot ${call.success ? "online" : ""}`} /><div><strong>{call.modelName}</strong><small>{call.agentId} · {call.latency} ms{call.routeAttempts && call.routeAttempts.length > 1 ? ` · ${call.routeAttempts.length} 次尝试` : ""}</small><p>{call.error ?? call.routeReason ?? "能力路由"}</p></div><time>{new Date(call.timestamp).toLocaleTimeString()}</time></div>)}{data?.calls.length === 0 && <div className="settings-empty">暂无模型调用记录</div>}</div>
    </div>
    <div className="settings-data-actions">
      <button className="btn btn-secondary" onClick={() => exportJson("/api/diagnostics/report", "eval-diagnostics")}><ActivityIcon size={13} />导出脱敏报告</button>
      <button className="btn btn-secondary" onClick={exportAudit}><ShieldIcon size={13} />导出安全审计</button>
      <button className="btn btn-secondary" onClick={() => exportJson("/api/config/backup", "eval-config")}><DownloadIcon size={13} />备份配置</button>
      <button className="btn btn-secondary" onClick={restore}><UploadIcon size={13} />恢复配置</button>
      {status && <span>{status}</span>}
    </div>
  </section>
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div> }
function CredentialMetric({ label, value, detail, state }: { label: string; value: string; detail: string; state: "ok" | "warning" | "error" | "neutral" }) { return <div><span className={`settings-status-dot ${state === "ok" ? "online" : state}`} /><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div> }
function credentialBackend(value: CredentialHealth): string { return value.backend === "windows-credential-manager" ? "Windows 凭据管理器" : value.backend }
function oldestCredentialLabel(value: number | null): string { return value ? `最早 ${new Date(value).toLocaleDateString()}` : "暂无凭据" }
function auditEventLabel(event: string): string { return ({ "model.sync": "模型凭据同步", "mcp.sync": "MCP 凭据同步", "webhook.sync": "Webhook 凭据同步" } as Record<string, string>)[event] ?? "凭据操作" }
function formatNumber(value: number): string { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value) }
