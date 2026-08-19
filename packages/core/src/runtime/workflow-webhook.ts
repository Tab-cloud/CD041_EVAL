import { createHmac } from "node:crypto"
import { assertSafeUrl } from "../tool/general/webfetch"
import type { WorkflowRunView } from "../store/workflow"
import {
  WorkflowWebhookRepo, type WorkflowWebhookDeliveryView, type WorkflowWebhookEvent,
} from "../store/workflow-webhook"

const RETRY_DELAYS_MS = [0, 1_000, 5_000]

export async function normalizeWorkflowWebhookUrl(raw: string): Promise<string> {
  const value = raw.trim()
  if (!value || value.length > 2_000) throw new Error("Webhook URL 为空或过长")
  return (await assertSafeUrl(value)).href
}

export async function deliverWorkflowWebhook(run: WorkflowRunView, event: "completed" | "failed"): Promise<WorkflowWebhookDeliveryView | null> {
  const settings = WorkflowWebhookRepo.getPrivateSettings()
  if (!settings.enabled || !settings.url || !settings.events.includes(event)) return null
  const payload = {
    version: 1,
    id: `${run.id}:${event}`,
    event: `workflow.${event}`,
    timestamp: Date.now(),
    workflow: {
      id: run.id, sessionId: run.sessionId, templateId: run.templateId, goal: run.goal,
      status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, completedAt: run.completedAt,
      nodes: run.nodes.map((node) => ({
        id: node.id, ordinal: node.ordinal, title: node.title, agentId: node.agentId,
        status: node.status, attempt: node.attempt, startedAt: node.startedAt, completedAt: node.completedAt,
      })),
    },
  }
  return deliver(settings.url, settings.secret, run.id, event, payload, RETRY_DELAYS_MS)
}

export async function testWorkflowWebhook(): Promise<WorkflowWebhookDeliveryView> {
  const settings = WorkflowWebhookRepo.getPrivateSettings()
  if (!settings.url) throw new Error("请先配置 Webhook URL")
  const payload = {
    version: 1, id: `test:${Date.now()}`, event: "workflow.test", timestamp: Date.now(),
    workflow: { id: "test", templateId: "test", goal: "Webhook 连通性测试", status: "completed", nodes: [] },
  }
  const delivery = await deliver(settings.url, settings.secret, undefined, "test", payload, [0])
  if (!delivery) throw new Error("Webhook 测试未执行")
  return delivery
}

async function deliver(
  rawUrl: string,
  secret: string,
  workflowId: string | undefined,
  event: WorkflowWebhookEvent,
  payload: unknown,
  delays: number[],
): Promise<WorkflowWebhookDeliveryView | null> {
  const url = await normalizeWorkflowWebhookUrl(rawUrl)
  const delivery = WorkflowWebhookRepo.reserve(workflowId, event, url)
  if (!delivery) return null
  const body = JSON.stringify(payload)
  const signature = secret ? signWorkflowWebhookBody(body, secret) : ""
  let lastError = ""
  let lastStatus: number | undefined
  for (let index = 0; index < delays.length; index++) {
    if (delays[index]) await wait(delays[index]!)
    try {
      await assertSafeUrl(url)
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json", "User-Agent": "Eval-Agent-Webhook/1.0",
          "X-Eval-Event": `workflow.${event}`, "X-Eval-Delivery": delivery.id,
          ...(signature ? { "X-Eval-Signature": signature } : {}),
        },
        body,
      })
      lastStatus = response.status
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      WorkflowWebhookRepo.updateDelivery(delivery.id, { status: "delivered", httpStatus: response.status, attempts: index + 1 })
      return WorkflowWebhookRepo.getDelivery(delivery.id)
    } catch (reason) {
      lastError = reason instanceof Error ? reason.message : String(reason)
    }
  }
  WorkflowWebhookRepo.updateDelivery(delivery.id, {
    status: "failed", httpStatus: lastStatus, attempts: delays.length, error: lastError.slice(0, 1_000),
  })
  return WorkflowWebhookRepo.getDelivery(delivery.id)
}

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

export function signWorkflowWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}
