import { apiFetch } from "./api"
import { expandCommand } from "./chat-commands"
import type { QueuedInstruction, SessionRunProjection } from "./store"

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024
const MAX_ATTACHMENT_COUNT = 10

type ApiTransport = (path: string, init?: RequestInit) => Promise<Response>

interface StagedSessionAttachment {
  name: string
  size: number
  mime: string
  kind: "image" | "text" | "binary"
  uploadId: string
}

const stagedAttachmentRequests = new Map<string, Promise<StagedSessionAttachment>>()

export class SessionCommandSubmissionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message)
    this.name = "SessionCommandSubmissionError"
  }
}

export function isRetryableSessionCommandError(error: unknown): boolean {
  return !(error instanceof SessionCommandSubmissionError) || error.retryable
}

export interface PublicSessionCommand {
  requestId: string
  sessionId: string
  sessionSeq: number
  state: "pending" | "processing" | "accepted" | "blocked" | "completed" | "failed" | "cancelled"
  taskId?: string
  problem?: { message?: string; diagnosticId?: string; retryable?: boolean }
  createdAt: number
  completedAt?: number
  text: string
  scope?: QueuedInstruction["scope"]
  effort: QueuedInstruction["effort"]
  modelId: string | null
  workingDir: string | null
  branchFrom?: QueuedInstruction["branchFrom"]
  attachments: Array<{
    name: string
    size: number
    kind: "image" | "text" | "binary"
  }>
}

export interface PublicRunGuidance {
  requestId: string
  taskId: string
  sessionId: string
  message: string
  state: "pending" | "applied" | "rejected"
  createdAt: number
  attachments: Array<{ name: string; kind: "image" | "text" | "binary" }>
}

export async function submitRunGuidance(input: {
  requestId: string
  taskId: string
  sessionId: string
  text: string
  attachments: QueuedInstruction["attachments"]
  workingDir: string | null
}, transport: ApiTransport = apiFetch): Promise<PublicRunGuidance> {
  const staged = await stageInstructionAttachments({
    id: input.requestId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    text: input.text,
    attachments: input.attachments,
    scope: "auto-edit",
    effort: "on",
    modelId: null,
    workingDir: input.workingDir,
    serverState: "local",
    createdAt: Date.now(),
  }, transport)
  const response = await transport("/api/tasks/guidance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: input.requestId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      message: input.text,
      attachments: staged,
    }),
  })
  const payload = await response.json().catch(() => ({})) as {
    error?: string
    guidance?: PublicRunGuidance
  }
  if (!response.ok || !payload.guidance) {
    throw responseError(payload.error || `任务引导提交失败: HTTP ${response.status}`, response.status)
  }
  clearStagedAttachmentRequests(input.requestId)
  return payload.guidance
}

export async function submitSessionCommand(instruction: QueuedInstruction): Promise<PublicSessionCommand> {
  const command = instruction.text.trim().split(/\s+/, 1)[0]
  const attachments = await stageInstructionAttachments(instruction)
  const message = instructionSubmissionMessage(instruction.text, attachments.length)
  const response = await apiFetch("/api/session-commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: instruction.requestId,
      sessionId: instruction.sessionId,
      message,
      displayMessage: instruction.text,
      command: command === "/init" ? command : undefined,
      agentId: instruction.agentIdOverride || "auto",
      modelId: instruction.modelId && instruction.modelId !== "auto" ? instruction.modelId : undefined,
      workingDir: instruction.workingDir ?? undefined,
      attachments,
      scope: instruction.scope,
      effort: instruction.effort,
      resumeTaskId: instruction.resumeTaskId,
      branchFrom: instruction.branchFrom,
      serialContext: instruction.serialContext,
    }),
  })
  const payload = await response.json().catch(() => ({})) as {
    error?: string
    command?: PublicSessionCommand
  }
  if (!response.ok && response.status !== 202) {
    throw responseError(payload.error || `命令提交失败: HTTP ${response.status}`, response.status)
  }
  if (!payload.command) throw new SessionCommandSubmissionError("命令提交后未返回持久化记录", true)
  clearStagedAttachmentRequests(instruction.requestId)
  return payload.command
}

export function instructionSubmissionMessage(text: string, attachmentCount: number): string {
  const expanded = expandCommand(text)
  return expanded.trim() || (attachmentCount > 0 ? "请分析随附文件。" : "")
}

export async function stageInstructionAttachments(
  instruction: QueuedInstruction,
  transport: ApiTransport = apiFetch,
): Promise<StagedSessionAttachment[]> {
  if (instruction.attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new SessionCommandSubmissionError("单次指令最多提交 10 个附件", false, 413)
  }
  const declaredTotal = instruction.attachments.reduce((sum, attachment) => {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new SessionCommandSubmissionError(`附件大小无效: ${attachment.name}`, false)
    }
    return sum + attachment.size
  }, 0)
  if (declaredTotal > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new SessionCommandSubmissionError("附件总大小超过 64MB", false, 413)
  }
  const staged = await Promise.all(instruction.attachments.map((attachment, index) => {
    if (attachment.uploadId) {
      return Promise.resolve(validateStagedAttachment({
        name: attachment.name,
        size: attachment.size,
        mime: attachment.mime,
        kind: attachment.kind,
        uploadId: attachment.uploadId,
      }, attachment, attachment.size))
    }
    const cacheKey = `${instruction.requestId}:${index}:${attachment.name}:${attachment.size}`
    const existing = stagedAttachmentRequests.get(cacheKey)
    if (existing) return existing
    const pending = uploadAttachment(attachment, transport).catch((error) => {
      stagedAttachmentRequests.delete(cacheKey)
      throw error
    })
    stagedAttachmentRequests.set(cacheKey, pending)
    return pending
  }))
  if (staged.reduce((sum, attachment) => sum + attachment.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    clearStagedAttachmentRequests(instruction.requestId)
    throw new SessionCommandSubmissionError("附件总大小超过 64MB", false, 413)
  }
  return staged
}

async function uploadAttachment(
  attachment: QueuedInstruction["attachments"][number],
  transport: ApiTransport,
): Promise<StagedSessionAttachment> {
  const bytes = attachmentBytes(attachment)
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new SessionCommandSubmissionError(`附件超过 32MB: ${attachment.name}`, false, 413)
  }
  const query = new URLSearchParams({
    name: attachment.name,
    mime: attachment.mime || "application/octet-stream",
    kind: attachment.kind,
  })
  const body = new Blob([
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  ])
  const response = await transport(`/api/attachments?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  })
  const payload = await response.json().catch(() => ({})) as {
    error?: string
    attachment?: StagedSessionAttachment
  }
  if (!response.ok || !payload.attachment) {
    throw responseError(payload.error || `附件上传失败: HTTP ${response.status}`, response.status)
  }
  return validateStagedAttachment(payload.attachment, attachment, bytes.byteLength)
}

function validateStagedAttachment(
  value: StagedSessionAttachment,
  expected: QueuedInstruction["attachments"][number],
  expectedSize: number,
): StagedSessionAttachment {
  const expectedMime = expected.mime || "application/octet-stream"
  const validKind = value?.kind === "image" || value?.kind === "text" || value?.kind === "binary"
  if (!value
    || typeof value.name !== "string"
    || typeof value.mime !== "string"
    || !validKind
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || value.size > MAX_ATTACHMENT_BYTES
    || !/^[a-f0-9]{64}$/i.test(value.uploadId ?? "")
    || value.name !== expected.name
    || value.mime !== expectedMime
    || value.kind !== expected.kind
    || value.size !== expectedSize) {
    throw new SessionCommandSubmissionError(`附件暂存响应无效: ${expected.name}`, true, 502)
  }
  return value
}

function attachmentBytes(attachment: QueuedInstruction["attachments"][number]): Uint8Array {
  if (typeof attachment.dataUrl === "string") {
    const comma = attachment.dataUrl.indexOf(",")
    if (comma < 0 || !attachment.dataUrl.slice(0, comma).endsWith(";base64")) {
      throw new SessionCommandSubmissionError(`图片附件数据无效: ${attachment.name}`, false)
    }
    return decodeBase64(attachment.dataUrl.slice(comma + 1), attachment.name)
  }
  if (typeof attachment.content === "string") return new TextEncoder().encode(attachment.content)
  if (typeof attachment.dataBase64 === "string") return decodeBase64(attachment.dataBase64, attachment.name)
  throw new SessionCommandSubmissionError(`附件缺少可提交内容: ${attachment.name}`, false)
}

function decodeBase64(value: string, name: string): Uint8Array {
  try {
    const decoded = atob(value)
    const bytes = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index)
    return bytes
  } catch {
    throw new SessionCommandSubmissionError(`附件 Base64 数据无效: ${name}`, false)
  }
}

function responseError(message: string, status: number): SessionCommandSubmissionError {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500
  return new SessionCommandSubmissionError(message, retryable, status)
}

function clearStagedAttachmentRequests(requestId: string): void {
  const prefix = `${requestId}:`
  for (const key of stagedAttachmentRequests.keys()) {
    if (key.startsWith(prefix)) stagedAttachmentRequests.delete(key)
  }
}

export async function loadPendingSessionCommands(): Promise<PublicSessionCommand[]> {
  const response = await apiFetch("/api/session-commands")
  const payload = await response.json().catch(() => ({})) as { commands?: PublicSessionCommand[] }
  if (!response.ok) throw new Error(`指令队列恢复失败: HTTP ${response.status}`)
  if (!Array.isArray(payload.commands)) throw new Error("指令队列恢复响应无效")
  return payload.commands
}

export async function subscribeSessionCommand(
  requestId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return apiFetch(
    `/api/session-commands/stream?requestId=${encodeURIComponent(requestId)}&sessionId=${encodeURIComponent(sessionId)}`,
    { signal },
  )
}

export async function cancelSessionCommand(requestId: string): Promise<void> {
  const response = await apiFetch(
    `/api/session-commands?requestId=${encodeURIComponent(requestId)}`,
    { method: "DELETE" },
  )
  if (response.ok || response.status === 404) return
  const payload = await response.json().catch(() => ({})) as { error?: string }
  throw new Error(payload.error || `取消指令失败: HTTP ${response.status}`)
}

export function commandToInstruction(
  command: PublicSessionCommand,
  previous?: QueuedInstruction,
): QueuedInstruction {
  return {
    id: previous?.id ?? command.requestId,
    requestId: command.requestId,
    sessionId: command.sessionId,
    text: command.text,
    // Once the POST is durable, the backend owns the staged bytes. Keep only
    // presentation metadata in renderer state/localStorage so a 32MB file is
    // not retained as a ~43MB Base64 queue record.
    attachments: command.attachments.map((attachment, index) => {
      const prior = previous?.attachments[index]
      return {
        ...attachment,
        path: "",
        mime: prior?.mime ?? "",
      }
    }),
    scope: command.scope ?? previous?.scope ?? "auto-edit",
    effort: command.effort,
    modelId: command.modelId,
    workingDir: command.workingDir,
    agentIdOverride: previous?.agentIdOverride,
    resumeTaskId: previous?.resumeTaskId,
    branchFrom: command.branchFrom ?? previous?.branchFrom,
    serverState: command.state === "accepted" ? "accepted"
      : command.state === "processing" ? "processing" : "pending",
    sessionSeq: command.sessionSeq,
    taskId: command.taskId,
    createdAt: command.createdAt,
  }
}

export function commandToRun(command: PublicSessionCommand): SessionRunProjection | null {
  if (!command.taskId) return null
  return {
    sessionId: command.sessionId,
    requestId: command.requestId,
    taskId: command.taskId,
    status: command.state === "accepted" ? "running" : command.state,
    startedAt: command.createdAt,
    updatedAt: command.completedAt ?? Date.now(),
  }
}
