import { useCallback, useEffect, useState } from "react"
import { apiFetch } from "../api"
import { runCredentialTransaction, stageWorkflowWebhookCredential, usesSystemCredentialStore } from "../model-credentials"
import { AlertCircleIcon, CheckCircleIcon, PlayIcon, SaveIcon, SpinnerIcon } from "./Icons"
import type { WorkflowWebhookDelivery, WorkflowWebhookSettings } from "./workflow-types"

export function WorkflowWebhookPanel() {
  const [settings, setSettings] = useState<WorkflowWebhookSettings | null>(null)
  const [deliveries, setDeliveries] = useState<WorkflowWebhookDelivery[]>([])
  const [url, setUrl] = useState("")
  const [enabled, setEnabled] = useState(false)
  const [events, setEvents] = useState<Array<"completed" | "failed">>(["completed", "failed"])
  const [secret, setSecret] = useState("")
  const [clearSecret, setClearSecret] = useState(false)
  const [busy, setBusy] = useState<"load" | "save" | "test" | null>("load")
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const response = await apiFetch("/api/workflow-webhook")
      const payload = await response.json().catch(() => ({})) as { settings?: WorkflowWebhookSettings; deliveries?: WorkflowWebhookDelivery[]; error?: string }
      if (!response.ok || !payload.settings) throw new Error(payload.error || "Webhook 设置加载失败")
      setSettings(payload.settings); setUrl(payload.settings.url); setEnabled(payload.settings.enabled); setEvents(payload.settings.events)
      setDeliveries(payload.deliveries ?? []); setError("")
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    setBusy("save")
    try {
      const requestBody = { url, enabled, events, ...(secret ? { secret } : {}), clearSecret }
      const validation = await apiFetch("/api/workflow-webhook/validate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody),
      })
      const validationPayload = await validation.json().catch(() => ({})) as { error?: string }
      if (!validation.ok) throw new Error(validationPayload.error || "Webhook 设置无效")
      const payload = await runCredentialTransaction(stageWorkflowWebhookCredential(secret, clearSecret), async () => {
        const response = await apiFetch("/api/workflow-webhook", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        })
        const result = await response.json().catch(() => ({})) as { settings?: WorkflowWebhookSettings; error?: string }
        if (!response.ok || !result.settings) throw new Error(result.error || "Webhook 设置保存失败")
        return result
      })
      if (!payload.settings) throw new Error("Webhook 设置保存失败")
      setSettings(payload.settings); setUrl(payload.settings.url); setEnabled(payload.settings.enabled); setEvents(payload.settings.events)
      setSecret(""); setClearSecret(false); setError(""); await load()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const test = async () => {
    setBusy("test")
    try {
      const response = await apiFetch("/api/workflow-webhook/test", { method: "POST" })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Webhook 测试失败")
      setError(""); await load()
    } catch (reason) { setError(messageOf(reason)); await load() }
    finally { setBusy(null) }
  }

  return (
    <section className="workflow-webhook">
      <div className="webhook-heading"><strong>Webhook</strong><button className={`schedule-toggle ${enabled ? "on" : ""}`} aria-label="启用 Webhook" aria-pressed={enabled} onClick={() => setEnabled((value) => !value)}><span /></button></div>
      {usesSystemCredentialStore() && <div className="webhook-credential-note">HMAC 密钥由 Windows 凭据管理器保护</div>}
      {error && <div className="tasks-error"><AlertCircleIcon size={12} />{error}</div>}
      <div className="webhook-form">
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/eval-webhook" maxLength={2_000} />
        <input type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={settings?.secretConfigured ? "签名密钥已配置（留空保持）" : "HMAC 签名密钥（可选）"} maxLength={256} />
        <div className="webhook-event-options"><label><input type="checkbox" checked={events.includes("completed")} onChange={() => setEvents(toggleEvent(events, "completed"))} />完成</label><label><input type="checkbox" checked={events.includes("failed")} onChange={() => setEvents(toggleEvent(events, "failed"))} />失败</label></div>
        {settings?.secretConfigured && <label><input type="checkbox" checked={clearSecret} onChange={(event) => setClearSecret(event.target.checked)} />清除现有密钥</label>}
        <div className="webhook-actions">
          <button className="panel-action-btn" disabled={busy !== null || !settings?.url} onClick={() => void test()}>{busy === "test" ? <SpinnerIcon size={11} className="spin" /> : <PlayIcon size={11} />}测试</button>
          <button className="panel-action-btn primary" disabled={busy !== null || (enabled && (!url.trim() || events.length === 0))} onClick={() => void save()}>{busy === "save" ? <SpinnerIcon size={11} className="spin" /> : <SaveIcon size={11} />}保存</button>
        </div>
      </div>
      {deliveries.length > 0 && <div className="webhook-deliveries">{deliveries.slice(0, 8).map((delivery) => <div className={delivery.status} key={delivery.id}>
        {delivery.status === "delivered" ? <CheckCircleIcon size={11} /> : delivery.status === "pending" ? <SpinnerIcon size={11} className="spin" /> : <AlertCircleIcon size={11} />}
        <span>{eventLabel(delivery.event)}</span><small>{delivery.httpStatus ? `HTTP ${delivery.httpStatus}` : delivery.error || "等待投递"}</small><time>{formatTime(delivery.createdAt)}</time>
      </div>)}</div>}
    </section>
  )
}

function eventLabel(event: WorkflowWebhookDelivery["event"]): string { return ({ completed: "完成", failed: "失败", test: "测试" })[event] }
function formatTime(value: number): string { return new Date(value).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) }
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function toggleEvent(events: Array<"completed" | "failed">, event: "completed" | "failed") {
  return events.includes(event) ? events.filter((value) => value !== event) : [...events, event]
}
