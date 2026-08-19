import { randomUUID } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentRegistry } from "../agent/registry.ts"
import type { ModelRouter } from "../model-router/index.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import { TaskRunRepo } from "../store/task-run.ts"
import {
  SessionCommandConflictError,
  SessionCommandRepo,
} from "../store/session-command.ts"
import type { AgentLoop } from "./agent-loop.ts"
import type { AgentOrchestrator } from "./orchestrator.ts"
import {
  acquireSessionCommand,
  SESSION_COMMAND_PROCESS_EPOCH,
} from "./session-command-queue.ts"
import { commandSubscriptionResponse } from "./session-command-subscription.ts"
import { AttachmentProcessingError, processAttachments } from "./server-attachments.ts"
import { getEffectiveSystemSettings } from "./project-settings.ts"
import { json } from "./server-response.ts"
import { checkChatRate, resolveCommandAgent } from "./server-chat-policy.ts"
import { normalizeScope } from "./tool-policy.ts"

export interface ChatDependencies {
  agentLoop: AgentLoop | null
  agentRegistry: AgentRegistry | null
  toolRegistry: ToolRegistry | null
  modelRouter: ModelRouter | null
  orchestrator: AgentOrchestrator | null
  /** Testable request-bound conversation relationship boundary. */
  conversationTurnResolver?: typeof import("./conversation-turn-intent.ts").resolveConversationTurnIntent
  /** Testable request-bound semantic protocol boundary; production uses the model analyzer. */
  semanticTaskAnalyzer?: typeof import("./semantic-task-analysis.ts").analyzeSemanticTask
}

export async function prepareChatRequest(
  rawBody: unknown,
  input: {
    modelRouter: ModelRouter | null
    agentRegistry: AgentRegistry | null
    systemReady: boolean
  },
) {
  const body = rawBody && typeof rawBody === "object"
    ? rawBody as Record<string, any>
    : {}
  const rawAttachments: any[] = Array.isArray(body.attachments) ? body.attachments : []
  const suppliedMessage = typeof body.message === "string" ? body.message : ""
  const message = suppliedMessage.trim()
    ? suppliedMessage
    : rawAttachments.length > 0 ? "请分析随附文件。" : ""
  if (!message.trim() || message.length > 50_000) {
    return failure(message ? "消息过长 (最大 50KB)" : "message 不能为空", 400)
  }
  const rawId = body.agentId as string | undefined
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : randomUUID()
  const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId : randomUUID()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return failure("无效的 sessionId", 400)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) return failure("无效的 requestId", 400)

  const resumeTaskId = typeof body.resumeTaskId === "string"
    && /^task-[A-Za-z0-9-]{1,128}$/.test(body.resumeTaskId)
    ? body.resumeTaskId
    : undefined
  const explicitResumeTask = resumeTaskId ? TaskRunRepo.get(resumeTaskId) : null
  if (resumeTaskId && (!explicitResumeTask || explicitResumeTask.sessionId !== sessionId)) {
    return failure("要恢复的任务不存在或不属于当前会话", 404)
  }

  const rawWorkingDir = typeof body.workingDir === "string" ? body.workingDir : process.cwd()
  let workingDir: string
  try {
    workingDir = realpathSync.native(resolve(rawWorkingDir))
    if (!statSync(workingDir).isDirectory()) throw new Error("不是目录")
  } catch {
    return failure("workingDir 不是有效目录", 400)
  }

  const systemSettings = getEffectiveSystemSettings(workingDir)
  const rawEffort = (body.effort as string) ?? systemSettings.defaultEffort
  const requestedScope = normalizeScope(body.scope ?? systemSettings.defaultScope)
  const requestedModelId = typeof body.modelId === "string" && body.modelId
    ? body.modelId
    : undefined
  const intentModelId = requestedModelId
    ?? (systemSettings.defaultModelId && input.modelRouter?.getModel(systemSettings.defaultModelId)
      ? systemSettings.defaultModelId
      : undefined)
  if (rawEffort !== "on" && rawEffort !== "off") return failure("无效的 effort", 400)
  const effort: "on" | "off" = rawEffort
  if (!requestedScope) return failure("无效的执行范围", 400)
  if (requestedModelId && requestedModelId.length > 600) return failure("modelId 过长", 400)
  if (requestedModelId && !input.modelRouter?.getModel(requestedModelId)) {
    return failure(`未知模型: ${requestedModelId}`, 400)
  }

  const commandAgentId = resolveCommandAgent(body.command)
  if (body.command !== undefined && !commandAgentId) return failure("不支持的命令", 400)
  const requestedAgentId = rawId && rawId !== "auto" ? rawId : undefined
  if (requestedAgentId && !input.agentRegistry?.get(requestedAgentId)) {
    return failure("指定的 Agent 不存在", 400)
  }
  if (!input.systemReady) return failure("Agent 系统未初始化", 503)

  let processedAttachments: Awaited<ReturnType<typeof processAttachments>>
  try {
    processedAttachments = await processAttachments(rawAttachments, workingDir)
  } catch (error) {
    if (error instanceof AttachmentProcessingError) return failure(error.message, 400)
    throw error
  }

  return {
    ok: true as const,
    value: {
      body,
      message,
      rawId,
      sessionId,
      requestId,
      resumeTaskId,
      explicitResumeTask,
      workingDir,
      systemSettings,
      effort,
      requestedScope,
      requestedModelId,
      intentModelId,
      commandAgentId,
      requestedAgentId,
      rawAttachments,
      processedAttachments,
    },
  }
}

export type PreparedChatRequest = Extract<
  Awaited<ReturnType<typeof prepareChatRequest>>,
  { ok: true }
>["value"]

/**
 * Owns the durable FIFO admission protocol before a root task is created.
 * HTTP arrival, duplicate replay and dispatcher execution therefore cannot
 * drift into separate queue implementations inside the conversation handler.
 */
export async function acquireChatCommand(input: {
  req: Request
  corsHeaders: Record<string, string>
  prepared: PreparedChatRequest
}): Promise<{ commandOwner: string } | { response: Response }> {
  const { req, corsHeaders, prepared } = input
  const {
    body, message, rawId, sessionId, requestId, resumeTaskId, workingDir,
    effort, requestedScope, requestedModelId, rawAttachments,
  } = prepared
  const dispatcherRequest = req.headers.get("x-eval-command-dispatcher") === SESSION_COMMAND_PROCESS_EPOCH
  let queued: ReturnType<typeof SessionCommandRepo.enqueue>
  if (dispatcherRequest) {
    const stored = SessionCommandRepo.get(requestId)
    if (!stored || stored.sessionId !== sessionId) {
      return { response: json({ error: "调度命令不存在或会话身份不一致" }, { ...corsHeaders, status: 409 }) }
    }
    queued = { command: stored, inserted: false }
  } else {
    try {
      queued = SessionCommandRepo.enqueue({
        requestId,
        sessionId,
        payload: JSON.stringify({
          message,
          sessionId,
          requestId,
          agentId: rawId,
          workingDir,
          modelId: requestedModelId,
          scope: requestedScope,
          effort,
          command: body.command,
          resumeTaskId,
          serialContext: body.serialContext,
          attachments: rawAttachments,
        }),
      })
    } catch (error) {
      if (error instanceof SessionCommandConflictError) {
        return { response: json({ error: error.message, requestId }, { ...corsHeaders, status: 409 }) }
      }
      throw error
    }
  }
  if (queued.inserted && !dispatcherRequest && !checkChatRate(sessionId)) {
    SessionCommandRepo.finish(requestId, "failed", "请求过于频繁，请稍后再试")
    return { response: json({ error: "请求过于频繁，请稍后再试" }, { ...corsHeaders, status: 429 }) }
  }
  if (!dispatcherRequest) {
    return { response: commandSubscriptionResponse(requestId, sessionId, corsHeaders) }
  }
  if (!queued.inserted && queued.command.taskId) {
    return { response: duplicateCommandResponse(queued.command, corsHeaders) }
  }
  const commandOwner = randomUUID()
  let command
  try {
    command = await acquireSessionCommand(requestId, commandOwner, req.signal)
  } catch (error) {
    SessionCommandRepo.releaseClaim(requestId, commandOwner)
    if (error instanceof Error && error.name === "AbortError") {
      return { response: json({ error: "请求已中止", requestId }, { ...corsHeaders, status: 499 }) }
    }
    throw error
  }
  return command.taskId || command.ownerToken !== commandOwner
    ? { response: duplicateCommandResponse(command, corsHeaders) }
    : { commandOwner }
}

export function duplicateCommandResponse(
  command: ReturnType<typeof SessionCommandRepo.get> extends infer T ? Exclude<T, null> : never,
  corsHeaders: Record<string, string>,
): Response {
  const task = command.taskId ? TaskRunRepo.get(command.taskId) : null
  const status = command.taskId
    ? 200
    : command.state === "pending" || command.state === "processing" ? 202 : 409
  return json({
    accepted: Boolean(command.taskId),
    duplicate: true,
    requestId: command.requestId,
    sessionId: command.sessionId,
    commandState: command.state,
    taskId: command.taskId,
    task,
    error: command.error,
  }, { ...corsHeaders, status })
}

function failure(error: string, status: number) {
  return { ok: false as const, error, status }
}
