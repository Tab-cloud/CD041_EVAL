import { realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { buildWorkflowReport, type WorkflowEngine } from "./workflow-engine"
import {
  WorkflowRepo, WorkflowScheduleRepo, type WorkflowFrequency, type WorkflowRunView,
} from "../store/workflow"
import { WorkflowWebhookRepo } from "../store/workflow-webhook"
import { json } from "./server-response"
import { normalizeWorkflowWebhookUrl, testWorkflowWebhook } from "./workflow-webhook"

export async function handleWorkflowRoutes(
  req: Request,
  url: URL,
  cors: Record<string, string>,
  engine: WorkflowEngine | null,
): Promise<Response | null> {
  const path = url.pathname
  if (!path.startsWith("/api/workflow")) return null
  if (!engine) return json({ error: "工作流引擎未初始化" }, { ...cors, status: 503 })

  if (path === "/api/workflow-webhook" && req.method === "GET") {
    return json({ settings: WorkflowWebhookRepo.getSettings(), deliveries: WorkflowWebhookRepo.listDeliveries(20) }, cors)
  }
  if (path === "/api/workflow-webhook/validate" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    try { await validateWebhookUpdate(body); return json({ success: true }, cors) }
    catch (error) { return json({ error: messageOf(error) }, { ...cors, status: 400 }) }
  }
  if (path === "/api/workflow-webhook" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    try {
      const { webhookUrl, enabled, events } = await validateWebhookUpdate(body)
      const settings = WorkflowWebhookRepo.updateSettings({
        url: webhookUrl, enabled,
        events,
        secret: typeof body.secret === "string" && body.secret ? body.secret : undefined,
        clearSecret: body.clearSecret === true,
      })
      return json({ settings }, cors)
    } catch (error) { return json({ error: messageOf(error) }, { ...cors, status: 400 }) }
  }
  if (path === "/api/workflow-webhook/test" && req.method === "POST") {
    try {
      const delivery = await testWorkflowWebhook()
      const status = delivery.status === "delivered" ? 200 : 502
      return json({ delivery, ...(status === 502 ? { error: delivery.error || "Webhook 投递失败" } : {}) }, { ...cors, status })
    } catch (error) { return json({ error: messageOf(error) }, { ...cors, status: 400 }) }
  }
  if (path === "/api/workflows/analytics" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? undefined
    const requestedDays = Number.parseInt(url.searchParams.get("days") ?? "30", 10)
    const days = Number.isFinite(requestedDays) ? requestedDays : 30
    return json({ analytics: WorkflowRepo.analytics(sessionId, days) }, cors)
  }
  if (path === "/api/workflows" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? undefined
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "30", 10)
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 30
    return json({ templates: engine.templates(), workflows: WorkflowRepo.list(sessionId, limit).map(projectPublicWorkflow) }, cors)
  }
  if (path === "/api/workflows" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    if (typeof body.sessionId !== "string" || typeof body.templateId !== "string" || typeof body.goal !== "string") {
      return json({ error: "缺少 sessionId、templateId 或 goal" }, { ...cors, status: 400 })
    }
    const workingDir = validDirectory(body.workingDir)
    if (!workingDir) return json({ error: "workingDir 不是有效目录" }, { ...cors, status: 400 })
    const workflow = engine.create({
      sessionId: body.sessionId, templateId: body.templateId, goal: body.goal, workingDir,
    })
    const started = body.start === false ? workflow : engine.start(workflow.id)
    return json({ workflow: projectPublicWorkflow(started) }, { ...cors, status: 201 })
  }
  if (path === "/api/workflows" && req.method === "DELETE") {
    const id = url.searchParams.get("id")
    if (!id) return json({ error: "缺少 id" }, { ...cors, status: 400 })
    const workflow = WorkflowRepo.get(id)
    if (!workflow) return json({ error: "工作流不存在" }, { ...cors, status: 404 })
    if (["running", "pausing"].includes(workflow.status)) return json({ error: "请先取消正在运行的工作流" }, { ...cors, status: 409 })
    WorkflowRepo.delete(id)
    return json({ success: true }, cors)
  }
  if (path === "/api/workflows/action" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    if (typeof body.workflowId !== "string" || typeof body.action !== "string") {
      return json({ error: "缺少 workflowId 或 action" }, { ...cors, status: 400 })
    }
    let workflow
    if (body.action === "start") workflow = engine.start(body.workflowId)
    else if (body.action === "pause") workflow = engine.pause(body.workflowId)
    else if (body.action === "resume") workflow = engine.resume(body.workflowId)
    else if (body.action === "cancel") workflow = engine.cancel(body.workflowId)
    else if (body.action === "retry-node" && typeof body.nodeId === "string") workflow = engine.retryNode(body.workflowId, body.nodeId)
    else if (body.action === "takeover" && typeof body.nodeId === "string") workflow = engine.takeOver(body.workflowId, body.nodeId)
    else if (body.action === "replay") workflow = engine.replay(body.workflowId, body.start !== false)
    else if (body.action === "complete-human" && typeof body.nodeId === "string" && typeof body.result === "string") {
      workflow = engine.completeHuman(body.workflowId, body.nodeId, body.result)
    } else return json({ error: "不支持的工作流操作或缺少节点参数" }, { ...cors, status: 400 })
    return json({ success: true, workflow: projectPublicWorkflow(workflow) }, cors)
  }
  if (path === "/api/workflows/report" && req.method === "GET") {
    const id = url.searchParams.get("id")
    const workflow = id ? WorkflowRepo.get(id) : null
    if (!workflow) return json({ error: "工作流不存在" }, { ...cors, status: 404 })
    return json({ report: workflow.report ?? "", workflow: projectPublicWorkflow(workflow) }, cors)
  }

  if (path === "/api/workflow-templates" && req.method === "POST") {
    const body = await req.json().catch(() => ({}))
    try { return json({ template: engine.createTemplate(body) }, { ...cors, status: 201 }) }
    catch (error) { return json({ error: messageOf(error) }, { ...cors, status: 400 }) }
  }
  if (path === "/api/workflow-templates" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    if (typeof body.id !== "string") return json({ error: "缺少模板 id" }, { ...cors, status: 400 })
    try { return json({ template: engine.updateTemplate(body.id, body) }, cors) }
    catch (error) { return json({ error: messageOf(error) }, { ...cors, status: 400 }) }
  }
  if (path === "/api/workflow-templates" && req.method === "DELETE") {
    const id = url.searchParams.get("id")
    if (!id) return json({ error: "缺少模板 id" }, { ...cors, status: 400 })
    try { engine.deleteTemplate(id); return json({ success: true }, cors) }
    catch (error) {
      const message = messageOf(error)
      return json({ error: message }, { ...cors, status: message.includes("定时计划引用") ? 409 : 400 })
    }
  }

  if (path === "/api/workflow-schedules" && req.method === "GET") {
    return json({ schedules: WorkflowScheduleRepo.list(url.searchParams.get("sessionId") ?? undefined) }, cors)
  }
  if (path === "/api/workflow-schedules" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const parsed = parseSchedule(body)
    if ("error" in parsed) return json({ error: parsed.error }, { ...cors, status: 400 })
    if (!engine.templates().some((template) => template.id === parsed.templateId)) {
      return json({ error: "工作流模板不存在" }, { ...cors, status: 400 })
    }
    return json({ schedule: WorkflowScheduleRepo.create(parsed) }, { ...cors, status: 201 })
  }
  if (path === "/api/workflow-schedules" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    if (typeof body.id !== "string" || !WorkflowScheduleRepo.get(body.id)) {
      return json({ error: "定时计划不存在" }, { ...cors, status: 404 })
    }
    const fields: Parameters<typeof WorkflowScheduleRepo.update>[1] = {}
    if (typeof body.name === "string" && body.name.trim()) fields.name = body.name.trim().slice(0, 100)
    if (typeof body.goal === "string" && body.goal.trim()) fields.goal = body.goal.trim().slice(0, 50_000)
    if (body.frequency === "once" || body.frequency === "interval") fields.frequency = body.frequency
    if (Number.isFinite(Number(body.intervalMinutes))) fields.intervalMinutes = clampInterval(body.intervalMinutes)
    if (Number.isFinite(Number(body.nextRunAt))) fields.nextRunAt = Number(body.nextRunAt)
    if (typeof body.enabled === "boolean") fields.enabled = body.enabled
    WorkflowScheduleRepo.update(body.id, fields)
    return json({ success: true, schedule: WorkflowScheduleRepo.get(body.id) }, cors)
  }
  if (path === "/api/workflow-schedules" && req.method === "DELETE") {
    const id = url.searchParams.get("id")
    if (!id) return json({ error: "缺少 id" }, { ...cors, status: 400 })
    WorkflowScheduleRepo.delete(id)
    return json({ success: true }, cors)
  }
  if (path === "/api/workflow-schedules/run" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { id?: unknown }
    if (typeof body.id !== "string") return json({ error: "缺少 id" }, { ...cors, status: 400 })
    return json({ success: true, workflow: projectPublicWorkflow(await engine.runScheduleNow(body.id)) }, cors)
  }
  return null
}

async function validateWebhookUpdate(body: Record<string, unknown>) {
  const current = WorkflowWebhookRepo.getSettings()
  const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled
  const events = Array.isArray(body.events)
    ? [...new Set(body.events.filter((event): event is "completed" | "failed" => event === "completed" || event === "failed"))]
    : current.events
  let webhookUrl = current.url
  if (typeof body.url === "string") webhookUrl = body.url.trim() ? await normalizeWorkflowWebhookUrl(body.url) : ""
  if (enabled && !webhookUrl) throw new Error("启用 Webhook 前需要配置 URL")
  if (enabled && events.length === 0) throw new Error("至少选择一种 Webhook 事件")
  if (body.secret !== undefined && (typeof body.secret !== "string" || body.secret.length > 256)) {
    throw new Error("Webhook 密钥格式无效或超过 256 字符")
  }
  return { webhookUrl, enabled, events }
}

function parseSchedule(body: Record<string, unknown>) {
  if (typeof body.name !== "string" || typeof body.sessionId !== "string" || typeof body.templateId !== "string" || typeof body.goal !== "string") {
    return { error: "缺少 name、sessionId、templateId 或 goal" } as const
  }
  const workingDir = validDirectory(body.workingDir)
  if (!workingDir) return { error: "workingDir 不是有效目录" } as const
  const frequency: WorkflowFrequency = body.frequency === "interval" ? "interval" : "once"
  const nextRunAt = Number(body.nextRunAt)
  if (!Number.isFinite(nextRunAt) || nextRunAt < Date.now() - 60_000) return { error: "nextRunAt 无效" } as const
  return {
    name: body.name.trim().slice(0, 100), sessionId: body.sessionId,
    templateId: body.templateId, goal: body.goal.trim().slice(0, 50_000), workingDir,
    frequency, intervalMinutes: frequency === "interval" ? clampInterval(body.intervalMinutes) : undefined,
    nextRunAt,
  }
}

function validDirectory(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) return null
  try {
    const path = realpathSync.native(resolve(value))
    return statSync(path).isDirectory() ? path : null
  } catch { return null }
}

function clampInterval(value: unknown): number {
  const number = Number(value)
  return Math.min(30 * 24 * 60, Math.max(1, Number.isFinite(number) ? Math.round(number) : 60))
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/**
 * Public workflow state is a project-level progress view owned by the main
 * Agent. Child identities, prompts, raw outputs, resource claims and task-run
 * lineage remain available only to the orchestration kernel and diagnostics.
 */
export function projectPublicWorkflow(workflow: WorkflowRunView) {
  const {
    sessionId: _sessionId,
    workingDir: _workingDir,
    report: _report,
    ...publicRun
  } = workflow
  return {
    ...publicRun,
    report: buildWorkflowReport(workflow),
    nodes: workflow.nodes.map((node) => {
      const {
        workflowId: _workflowId,
        agentId: _agentId,
        prompt: _prompt,
        result: _result,
        error: _error,
        resourceClaims: _resourceClaims,
        taskRunId: _taskRunId,
        updatedAt: _updatedAt,
        ...publicNode
      } = node
      return publicNode
    }),
  }
}
