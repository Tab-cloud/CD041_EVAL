import type { SessionCommandView } from "../store/session-command.ts"
import { projectPublicProblem } from "./public-run-event.ts"

export interface PublicAttachmentSummary {
  name: string
  size: number
  kind: "image" | "text" | "binary"
}

export function publicSessionCommand(command: SessionCommandView) {
  const payload = parsePayload(command.payload)
  return {
    requestId: command.requestId,
    sessionId: command.sessionId,
    sessionSeq: command.sessionSeq,
    state: command.state,
    taskId: command.taskId,
    problem: command.error ? projectPublicProblem(command.error, command.state) : undefined,
    createdAt: command.createdAt,
    completedAt: command.completedAt,
    text: typeof payload.displayMessage === "string"
      ? payload.displayMessage
      : typeof payload.message === "string" ? payload.message : "",
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    effort: payload.effort === "off" ? "off" : "on",
    modelId: typeof payload.modelId === "string" ? payload.modelId : null,
    workingDir: typeof payload.workingDir === "string" ? payload.workingDir : null,
    branchFrom: publicConversationBranch(payload.branchFrom),
    attachments: publicAttachmentSummaries(payload),
  }
}

function publicConversationBranch(value: unknown): { requestId?: string; seq?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const branch = value as Record<string, unknown>
  const requestId = typeof branch.requestId === "string" ? branch.requestId : undefined
  const seq = Number.isSafeInteger(branch.seq) && Number(branch.seq) > 0 ? Number(branch.seq) : undefined
  return requestId || seq ? { requestId, seq } : undefined
}

export function publicAttachmentSummaries(
  payloadOrJson: Record<string, unknown> | string,
): PublicAttachmentSummary[] {
  const payload = typeof payloadOrJson === "string"
    ? parsePayload(payloadOrJson)
    : payloadOrJson
  if (!Array.isArray(payload.attachments)) return []
  return payload.attachments.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const attachment = item as Record<string, unknown>
    if (typeof attachment.name !== "string") return []
    const kind = attachment.kind === "image" || attachment.kind === "text"
      ? attachment.kind
      : "binary"
    return [{
      name: attachment.name,
      size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : 0,
      kind,
    }]
  })
}

function parsePayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload)
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
