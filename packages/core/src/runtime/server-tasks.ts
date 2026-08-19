import { checkpointManager } from "../store/checkpoint"
import { TaskRunRepo } from "../store/task-run"
import { ExecutionRunRepo } from "../store/execution-run"
import type { ExecutionSnapshot } from "./agent-loop-control"
import { taskScheduler } from "./task-scheduler"
import { toolApprovalManager } from "./tool-approval"
import { json } from "./server-response"
import { RunEventRepo } from "../store/run-event.ts"
import { BuildLogRepo } from "../store/build-log.ts"
import { RunGraphRepo } from "../store/run-graph.ts"
import { runGraphService } from "./run-graph.ts"
import { publicExecutionStopReason } from "./execution-terminal.ts"
import { userQuestionManager } from "./user-question.ts"
import {
  projectPublicApproval,
  projectPublicHttpTask,
  projectPublicQuestion,
  projectPublicRunEventRecords,
} from "./public-run-event.ts"
import {
  SessionCommandBranchError,
  SessionCommandConflictError,
  SessionCommandRepo,
} from "../store/session-command.ts"
import { commandSubscriptionResponse } from "./session-command-subscription.ts"
import { publicSessionCommand } from "./session-command-projection.ts"
import {
  AttachmentProcessingError,
  MAX_ATTACHMENT_UPLOAD_BODY_BYTES,
  processAttachments,
  stageUploadedAttachment,
} from "./server-attachments.ts"
import {
  RunGuidanceAdmissionError,
  RunGuidanceConflictError,
  RunGuidanceRepo,
} from "../store/run-guidance.ts"

export async function handleTaskRoutes(
  req: Request,
  url: URL,
  cors: Record<string, string>,
): Promise<Response | null> {
  const path = url.pathname
  if (path === "/api/tasks/guidance" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const requestId = typeof body.requestId === "string" ? body.requestId : ""
    const rootRunId = typeof body.taskId === "string" ? body.taskId : ""
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
    const suppliedMessage = typeof body.message === "string" ? body.message : ""
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : []
    const message = suppliedMessage.trim()
      ? suppliedMessage.trim()
      : rawAttachments.length > 0 ? "请结合补充附件继续当前任务。" : ""
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
      || !/^task-[A-Za-z0-9-]{1,128}$/.test(rootRunId)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
      || !message
      || message.length > 50_000) {
      return json({ error: "任务引导缺少有效的 requestId、taskId、sessionId 或 message" }, { ...cors, status: 400 })
    }
    const task = TaskRunRepo.get(rootRunId)
    if (!task || task.sessionId !== sessionId) {
      return json({ error: "当前任务不存在或不属于这个会话" }, { ...cors, status: 404 })
    }
    let attachments
    try {
      attachments = await processAttachments(rawAttachments, task.workingDir)
    } catch (error) {
      if (error instanceof AttachmentProcessingError) {
        return json({ error: error.message }, { ...cors, status: 400 })
      }
      throw error
    }
    try {
      const result = RunGuidanceRepo.submit({
        requestId,
        rootRunId,
        sessionId,
        message,
        attachments,
      })
      return json({
        accepted: true,
        duplicate: !result.inserted,
        guidance: publicRunGuidance(result.guidance),
      }, { ...cors, status: result.inserted ? 201 : 200 })
    } catch (error) {
      if (error instanceof RunGuidanceConflictError) {
        return json({ error: error.message, requestId }, { ...cors, status: 409 })
      }
      if (error instanceof RunGuidanceAdmissionError) {
        return json({ error: error.message }, { ...cors, status: error.status })
      }
      throw error
    }
  }
  if (path === "/api/attachments" && req.method === "POST") {
    const declaredLength = Number(req.headers.get("content-length") ?? "0")
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) {
      return json({ error: "附件超过 32MB" }, { ...cors, status: 413 })
    }
    const name = url.searchParams.get("name") ?? ""
    const mime = url.searchParams.get("mime") ?? "application/octet-stream"
    const kind = url.searchParams.get("kind") ?? "binary"
    try {
      const bytes = new Uint8Array(await req.arrayBuffer())
      if (bytes.byteLength > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) {
        return json({ error: "附件超过 32MB" }, { ...cors, status: 413 })
      }
      const attachment = await stageUploadedAttachment({ name, mime, kind, bytes })
      return json({ attachment }, { ...cors, status: 201 })
    } catch (error) {
      if (error instanceof AttachmentProcessingError) {
        return json({ error: error.message }, { ...cors, status: 400 })
      }
      throw error
    }
  }
  if (path === "/api/tasks" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId")
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10)
    const graphs = sessionId ? RunGraphRepo.listBySession(sessionId, limit) : []
    const graph = graphs[0] ?? null
    const tasks = sessionId
      ? graphs.flatMap((item) => {
          const node = item.nodes.find((candidate) => candidate.kind === "root")
          return node ? [graphRootTask(item, node)] : []
        })
      : TaskRunRepo.listRecent(limit)
        .filter(isPublicTask)
        .map(projectHttpTask)
        .filter(isPresent)
    const running = taskScheduler.getRunning().filter(isPublicTask)
    const queued = taskScheduler.getQueue().filter(isPublicTask)
    const latestRoot = tasks[0]
    return json({
      stats: publicStats(tasks, running.length, queued.length),
      running: running.map(projectHttpTask).filter(isPresent),
      queued: queued.map(projectHttpTask).filter(isPresent),
      tasks,
      checkpoint: sessionId ? checkpointSummary(sessionId) : null,
      // Approvals are application-level interrupts. Never hide requests from
      // background sessions merely because another conversation is selected.
      approvals: toolApprovalManager.list().map(projectPublicApproval).filter(isPresent),
      questions: userQuestionManager.list().map(projectPublicQuestion).filter(isPresent),
      execution: latestRoot ? publicExecutionState(ExecutionRunRepo.get(latestRoot.id)?.snapshot) : null,
      graph: graph ? publicRunGraph(graph) : null,
    }, cors)
  }
  if (path === "/api/tasks" && req.method === "DELETE") {
    taskScheduler.clearQueue()
    return json({ success: true }, cors)
  }
  if (path === "/api/tasks/status" && req.method === "GET") {
    const id = url.searchParams.get("id") ?? ""
    const requestId = url.searchParams.get("requestId") ?? ""
    if (!id && !requestId) return json({ error: "缺少有效的 id 或 requestId" }, { ...cors, status: 400 })
    const metadata = id ? TaskRunRepo.get(id) : TaskRunRepo.getByRequestId(requestId)
    if (!metadata || !isPublicTask(metadata)) return json({ error: "任务不存在" }, { ...cors, status: 404 })
    const graph = RunGraphRepo.get(metadata.id)
    const node = graph?.nodes.find((candidate) => candidate.id === metadata.id && candidate.kind === "root")
    if (!graph || !node) {
      // A damaged/missing graph must not turn a valid durable task into an
      // endless client recovery loop. TaskRun is the degraded terminal truth;
      // surface the integrity fault explicitly so clients can stop polling.
      return json({
        task: projectHttpTask(metadata),
        approvals: toolApprovalManager.list().map(projectPublicApproval).filter(isPresent),
        questions: userQuestionManager.list().map(projectPublicQuestion).filter(isPresent),
        execution: publicExecutionState(ExecutionRunRepo.get(metadata.id)?.snapshot),
        graph: null,
        integrity: {
          status: "degraded",
          reason: "task-graph-missing",
          recoverable: false,
        },
      }, cors)
    }
    // 恢复通道同时返回该任务会话的待审批项。这样 SSE 中断时，
    // 前端仍能把阻塞交互立即投影到主聊天区，而不是静默等待。
    return json({
      task: projectHttpTask({ ...metadata, status: graphNodePublicStatus(node.status) }),
      approvals: toolApprovalManager.list().map(projectPublicApproval).filter(isPresent),
      questions: userQuestionManager.list().map(projectPublicQuestion).filter(isPresent),
      execution: publicExecutionState(ExecutionRunRepo.get(metadata.id)?.snapshot),
      graph: publicRunGraph(graph),
    }, cors)
  }
  if (path === "/api/tasks/events" && req.method === "GET") {
    const id = url.searchParams.get("id") ?? ""
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10)
    if (!id) return json({ error: "缺少有效的 id" }, { ...cors, status: 400 })
    const task = TaskRunRepo.get(id)
    if (!task || !isPublicTask(task)) return json({ error: "任务不存在" }, { ...cors, status: 404 })
    return json({ events: projectPublicRunEventRecords(RunEventRepo.listAfter(id, after)) }, cors)
  }
  if (path === "/api/session-commands/stream" && req.method === "GET") {
    const requestId = url.searchParams.get("requestId") ?? ""
    const sessionId = url.searchParams.get("sessionId") ?? ""
    const command = requestId ? SessionCommandRepo.get(requestId) : null
    if (!command) return json({ error: "命令不存在" }, { ...cors, status: 404 })
    if (sessionId && command.sessionId !== sessionId) {
      return json({ error: "命令不属于当前会话" }, { ...cors, status: 409 })
    }
    return commandSubscriptionResponse(command.requestId, command.sessionId, cors)
  }
  if (path === "/api/session-commands" && req.method === "GET") {
    const requestId = url.searchParams.get("requestId") ?? ""
    const sessionId = url.searchParams.get("sessionId") ?? ""
    if (requestId) {
      const command = SessionCommandRepo.get(requestId)
      return command
        ? json({ command: publicSessionCommand(command) }, cors)
        : json({ error: "命令不存在" }, { ...cors, status: 404 })
    }
    return json({
      commands: SessionCommandRepo.listPending(sessionId || undefined).map(publicSessionCommand),
    }, cors)
  }
  if (path === "/api/session-commands" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const requestId = typeof body.requestId === "string" ? body.requestId : ""
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
    const suppliedMessage = typeof body.message === "string" ? body.message : ""
    const message = suppliedMessage.trim()
      ? suppliedMessage
      : Array.isArray(body.attachments) && body.attachments.length > 0 ? "请分析随附文件。" : ""
    body.message = message
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
      || !message.trim()
      || message.length > 50_000) {
      return json({ error: "命令缺少有效的 requestId、sessionId 或 message" }, { ...cors, status: 400 })
    }
    let result: ReturnType<typeof SessionCommandRepo.enqueue>
    try {
      result = SessionCommandRepo.enqueue({
        requestId,
        sessionId,
        payload: JSON.stringify(body),
      })
    } catch (error) {
      if (error instanceof SessionCommandConflictError || error instanceof SessionCommandBranchError) {
        return json({ error: error.message, requestId }, { ...cors, status: 409 })
      }
      throw error
    }
    const command = result.command.taskId
      ? result.command
      : SessionCommandRepo.get(requestId) ?? result.command
    return json({
      accepted: Boolean(command.taskId),
      duplicate: !result.inserted,
      command: publicSessionCommand(command),
    }, { ...cors, status: command.taskId ? 200 : 202 })
  }
  if (path === "/api/session-commands" && req.method === "DELETE") {
    const requestId = url.searchParams.get("requestId") ?? ""
    const command = requestId ? SessionCommandRepo.get(requestId) : null
    if (!command) return json({ error: "命令不存在" }, { ...cors, status: 404 })
    if (!command.taskId) {
      const cancelled = SessionCommandRepo.finish(requestId, "cancelled", "用户已从指令队列移除")
      return json({ command: cancelled ? publicSessionCommand(cancelled) : null }, cors)
    }

    taskScheduler.cancel(command.taskId)
    const task = taskScheduler.getTask(command.taskId) ?? TaskRunRepo.get(command.taskId)
    // Queued work has no live Worker and can reach cancelled synchronously.
    // A running Worker enters the scheduler's cancelling phase and continues
    // to own its lane/resources until server-chat's worker finally confirms
    // exit. Publishing a terminal command before that acknowledgement would
    // let the next command start against a still-running predecessor.
    const current = task?.status === "cancelled"
      ? SessionCommandRepo.finish(requestId, "cancelled", task.error || "用户已从指令队列移除")
      : SessionCommandRepo.get(requestId)
    return json({
      command: current ? publicSessionCommand(current) : null,
      cancellationPending: task?.status === "cancelling",
    }, { ...cors, status: task?.status === "cancelling" ? 202 : 200 })
  }
  if (path === "/api/tasks/logs" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? ""
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "500", 10)
    if (!sessionId) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
    return json({
      events: projectPublicRunEventRecords(RunEventRepo.listPublicLogsBySession(sessionId, limit)),
    }, cors)
  }
  if (path === "/api/tasks/logs" && req.method === "DELETE") {
    const sessionId = url.searchParams.get("sessionId") ?? ""
    if (!sessionId) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
    RunEventRepo.deletePublicLogsBySession(sessionId)
    return json({ success: true }, cors)
  }
  if (path === "/api/build/logs" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") ?? ""
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "5000", 10)
    if (!sessionId) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
    return json({ events: BuildLogRepo.listBySession(sessionId, limit) }, cors)
  }
  if (path === "/api/build/logs" && req.method === "DELETE") {
    const sessionId = url.searchParams.get("sessionId") ?? ""
    if (!sessionId) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
    BuildLogRepo.deleteBySession(sessionId)
    return json({ success: true }, cors)
  }
  if (path === "/api/tasks/cancel" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { id?: unknown }
    if (typeof body.id !== "string" || !body.id) return json({ error: "缺少有效的 id" }, { ...cors, status: 400 })
    const metadata = taskScheduler.getTask(body.id) ?? TaskRunRepo.get(body.id)
    const node = RunGraphRepo.getNode(body.id)
    if (!metadata || !isPublicTask(metadata) || !node || node.kind !== "root") {
      return json({ error: "任务不存在" }, { ...cors, status: 404 })
    }
    if (["accepted", "failed", "cancelled", "interrupted"].includes(node.status)) {
      return json({
        success: true,
        task: projectHttpTask({ ...metadata, status: graphNodePublicStatus(node.status) }),
      }, cors)
    }
    let cancelled = taskScheduler.cancel(body.id)
    if (!cancelled) {
      const cancelledIds = runGraphService.cancelNode(body.id)
      const now = Date.now()
      for (const taskId of cancelledIds) {
        const durable = TaskRunRepo.get(taskId)
        if (durable) TaskRunRepo.update({ ...durable, status: "cancelled", completedAt: now })
      }
      cancelled = cancelledIds.length > 0
    }
    const updated = TaskRunRepo.get(body.id) ?? metadata
    const updatedNode = RunGraphRepo.getNode(body.id)!
    return json({
      success: cancelled,
      task: projectHttpTask({ ...updated, status: graphNodePublicStatus(updatedNode.status) }),
    }, cors)
  }
  if (path === "/api/tasks/retry" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { id?: unknown }
    if (typeof body.id !== "string" || !body.id) return json({ error: "缺少有效的 id" }, { ...cors, status: 400 })
    const task = TaskRunRepo.get(body.id)
    const node = RunGraphRepo.getNode(body.id)
    if (!task || !isPublicTask(task) || !node || node.kind !== "root") {
      return json({ error: "任务不存在" }, { ...cors, status: 404 })
    }
    if (!["blocked", "failed", "cancelled", "interrupted"].includes(node.status)) {
      return json({ error: "只有失败、取消或中断的任务可以重试" }, { ...cors, status: 409 })
    }
    return json({
      retry: {
        sourceTaskId: task.id,
        sessionId: task.sessionId,
        message: task.message,
        scope: task.scope ?? "auto-edit",
        effort: task.effort ?? "on",
        modelId: task.modelId,
      },
    }, cors)
  }
  if (path === "/api/checkpoint" && req.method === "GET") {
    return json(checkpointSummary(url.searchParams.get("sessionId") ?? ""), cors)
  }
  if (path === "/api/checkpoint/resume" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { sessionId?: unknown }
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
    }
    const context = checkpointManager.resumeContext(body.sessionId)
    if (!context) return json({ hasUnfinished: false }, cors)
    const tools = pendingToolNames(context.pendingToolCalls)
    const resumePrompt = [
      `上次任务在第 ${context.step} 步中断。`,
      tools.length > 0 ? `当时待处理工具：${tools.join("、")}。` : "",
      "请先重新检查当前工作区和已有变更，确认哪些步骤已经完成，再从安全位置继续。不要直接重复可能产生副作用的操作。",
    ].filter(Boolean).join("\n")
    // Keep the durable checkpoint until the resumed run finishes. Deleting it
    // before the client has successfully started a new run creates a loss window.
    return json({ hasUnfinished: true, step: context.step, tools, resumePrompt }, cors)
  }
  if (path === "/api/checkpoint" && req.method === "DELETE") {
    const sessionId = url.searchParams.get("sessionId") ?? ""
    if (!sessionId) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
    checkpointManager.clear(sessionId)
    return json({ success: true }, cors)
  }
  return null
}

function graphNodePublicStatus(status: string): string {
  if (status === "accepted") return "completed"
  return status
}

function graphRootTask(
  graph: NonNullable<ReturnType<typeof RunGraphRepo.get>>,
  node: NonNullable<ReturnType<typeof RunGraphRepo.getNode>>,
) {
  const metadata = TaskRunRepo.get(node.id)
  return projectHttpTask({
    id: node.id,
    requestId: metadata?.requestId,
    sessionId: graph.sessionId,
    status: graphNodePublicStatus(node.status),
    message: graph.objective,
    type: "chat" as const,
    createdAt: node.createdAt,
    startedAt: metadata?.startedAt,
    completedAt: metadata?.completedAt,
  })!
}

export function publicRunGraph(graph: NonNullable<ReturnType<typeof RunGraphRepo.get>>) {
  return {
    id: graph.id,
    version: graph.version,
    status: graph.status,
    objective: graph.objective,
    updatedAt: graph.updatedAt,
    nodes: graph.nodes
      .filter((node) => node.kind === "root")
      .map((node) => ({
        id: node.id,
        logicalTaskId: node.logicalTaskId,
        kind: node.kind,
        status: node.status,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      })),
    edges: [],
  }
}

export function publicRunGraphEvents(
  events: ReturnType<typeof RunGraphRepo.eventsAfter>,
) {
  return events.map((event) => ({
    graphId: event.graphId,
    version: event.version,
    type: "graph-updated",
    payload: {},
    createdAt: event.createdAt,
  }))
}

function publicExecutionState(snapshot: ExecutionSnapshot | undefined) {
  if (!snapshot) return null
  return {
    state: snapshot.state,
    todos: snapshot.todos,
    stopReason: publicExecutionStopReason(
      snapshot.stopReason,
      snapshot.todos.filter((todo) => todo.status !== "completed").length,
    ),
    updatedAt: snapshot.updatedAt,
  }
}

function checkpointSummary(sessionId: string) {
  if (!sessionId) return { hasCheckpoint: false }
  const checkpoint = checkpointManager.loadLatest(sessionId)
  if (!checkpoint) return { hasCheckpoint: false }
  let pending: unknown[] = []
  try { pending = JSON.parse(checkpoint.pendingToolCalls) as unknown[] } catch {}
  return {
    hasCheckpoint: pending.length > 0,
    step: checkpoint.step,
    tools: pendingToolNames(pending),
    updatedAt: checkpoint.updatedAt,
  }
}

function pendingToolNames(pending: unknown[]): string[] {
  return [...new Set(pending.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const name = (item as { name?: unknown }).name
    return typeof name === "string" ? [name] : []
  }))]
}

function publicRunGuidance(value: ReturnType<typeof RunGuidanceRepo.list>[number]) {
  return {
    requestId: value.requestId,
    taskId: value.rootRunId,
    sessionId: value.sessionId,
    message: value.message,
    state: value.state,
    createdAt: value.createdAt,
    attachments: value.attachments.map(({ name, kind }) => ({ name, kind })),
  }
}

export function isPublicTask(task: { type: string }): boolean {
  return task.type === "chat"
}

export function projectPublicTask<T extends { status: string; type: string }>(task: T): T | null {
  return isPublicTask(task) ? publicTask(task) : null
}

function publicTask<T extends { status: string }>(task: T): T {
  return { ...task, status: publicStatus(task.status) } as T
}

export function publicStatus(status: string): string {
  return status === "waiting-delegation" ? "running" : status
}

function publicStats(
  tasks: Array<{ status: string }>,
  running: number,
  queued: number,
) {
  return {
    queued,
    running,
    waitingApproval: tasks.filter((task) => task.status === "waiting-approval").length,
    waitingDelegation: 0,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => ["failed", "interrupted"].includes(task.status)).length,
    maxConcurrency: taskScheduler.getStats().maxConcurrency,
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

function projectHttpTask(task: {
  id: string
  status: string
  type: string
  message: string
  createdAt: number
  requestId?: string
  sessionId?: string
  startedAt?: number
  completedAt?: number
  error?: string
}) {
  return projectPublicHttpTask({
    ...task,
    status: publicStatus(task.status),
  })
}
