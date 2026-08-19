import { randomUUID } from "node:crypto"
import { getDb } from "./database"

export type WorkflowWebhookEvent = "completed" | "failed" | "test"
export type WorkflowWebhookDeliveryStatus = "pending" | "delivered" | "failed"

interface SettingsRow { url: string; secret: string; enabled: number; events: string; updated_at: number }
interface DeliveryRow {
  id: string; workflow_id: string | null; event: WorkflowWebhookEvent; url: string
  status: WorkflowWebhookDeliveryStatus; http_status: number | null; attempts: number
  error: string | null; created_at: number; updated_at: number
}

const EXTERNAL_CREDENTIALS = process.env.EVAL_CREDENTIAL_STORE === "external"
let externalSecret = process.env.EVAL_WORKFLOW_WEBHOOK_SECRET ?? ""

export function setWorkflowWebhookCredential(secret: string): void {
  if (EXTERNAL_CREDENTIALS) externalSecret = secret.slice(0, 2_048)
}

export interface WorkflowWebhookSettingsView {
  url: string
  enabled: boolean
  events: Array<"completed" | "failed">
  secretConfigured: boolean
  updatedAt: number
}

export interface WorkflowWebhookDeliveryView {
  id: string
  workflowId?: string
  event: WorkflowWebhookEvent
  status: WorkflowWebhookDeliveryStatus
  httpStatus?: number
  attempts: number
  error?: string
  createdAt: number
  updatedAt: number
}

export const WorkflowWebhookRepo = {
  recoverInterrupted(): number {
    const now = Date.now()
    const result = getDb().run(
      "UPDATE workflow_webhook_deliveries SET status = 'failed', error = ?, updated_at = ? WHERE status = 'pending'",
      ["Agent 服务已重启，Webhook 投递被中断", now],
    )
    return result.changes
  },

  getSettings(): WorkflowWebhookSettingsView {
    const row = getSettingsRow()
    return {
      url: row.url, enabled: row.enabled === 1, events: parseEvents(row.events),
      secretConfigured: Boolean(privateSecret(row)), updatedAt: row.updated_at,
    }
  },

  getPrivateSettings(): WorkflowWebhookSettingsView & { secret: string } {
    const row = getSettingsRow()
    return { ...this.getSettings(), secret: privateSecret(row) }
  },

  updateSettings(input: { url: string; enabled: boolean; events?: Array<"completed" | "failed">; secret?: string; clearSecret?: boolean }): WorkflowWebhookSettingsView {
    const current = getSettingsRow()
    let secret = input.clearSecret ? "" : input.secret === undefined ? privateSecret(current) : input.secret
    if (EXTERNAL_CREDENTIALS) {
      if (input.clearSecret) externalSecret = ""
      else if (input.secret !== undefined) externalSecret = input.secret
      secret = ""
    }
    const events = input.events ?? parseEvents(current.events)
    getDb().run(
      "UPDATE workflow_webhook_settings SET url = ?, secret = ?, enabled = ?, events = ?, updated_at = ? WHERE id = 'default'",
      [input.url, secret, input.enabled ? 1 : 0, JSON.stringify(events), Date.now()],
    )
    return this.getSettings()
  },

  reserve(workflowId: string | undefined, event: WorkflowWebhookEvent, url: string): WorkflowWebhookDeliveryView | null {
    const id = `workflow-webhook-${randomUUID()}`
    const now = Date.now()
    const result = getDb().run(
      `INSERT OR IGNORE INTO workflow_webhook_deliveries
        (id, workflow_id, event, url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [id, workflowId ?? null, event, url, now, now],
    )
    return result.changes === 0 ? null : this.getDelivery(id)
  },

  updateDelivery(id: string, input: { status: WorkflowWebhookDeliveryStatus; httpStatus?: number; attempts: number; error?: string }): void {
    getDb().run(
      "UPDATE workflow_webhook_deliveries SET status = ?, http_status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?",
      [input.status, input.httpStatus ?? null, input.attempts, input.error ?? null, Date.now(), id],
    )
  },

  getDelivery(id: string): WorkflowWebhookDeliveryView | null {
    const row = getDb().query("SELECT * FROM workflow_webhook_deliveries WHERE id = ?").get(id) as DeliveryRow | null
    return row ? mapDelivery(row) : null
  },

  listDeliveries(requestedLimit = 20): WorkflowWebhookDeliveryView[] {
    const limit = Math.max(1, Math.min(50, requestedLimit))
    return (getDb().query("SELECT * FROM workflow_webhook_deliveries ORDER BY created_at DESC LIMIT ?").all(limit) as DeliveryRow[])
      .map(mapDelivery)
  },
}

function privateSecret(row: SettingsRow): string {
  return EXTERNAL_CREDENTIALS ? externalSecret || row.secret : row.secret
}

function getSettingsRow(): SettingsRow {
  const row = getDb().query("SELECT * FROM workflow_webhook_settings WHERE id = 'default'").get() as SettingsRow | null
  if (!row) throw new Error("Webhook 设置未初始化")
  return row
}

function mapDelivery(row: DeliveryRow): WorkflowWebhookDeliveryView {
  return {
    id: row.id, workflowId: row.workflow_id ?? undefined, event: row.event, status: row.status,
    httpStatus: row.http_status ?? undefined, attempts: row.attempts, error: row.error ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function parseEvents(raw: string): Array<"completed" | "failed"> {
  try {
    const values = JSON.parse(raw) as unknown[]
    return [...new Set(values.filter((value): value is "completed" | "failed" => value === "completed" || value === "failed"))]
  } catch { return ["completed", "failed"] }
}
