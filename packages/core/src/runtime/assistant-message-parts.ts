import { RunEventRepo } from "../store/run-event.ts"
import { SessionCommandRepo } from "../store/session-command.ts"

export interface PublicAssistantPart {
  id: string
  type: "reasoning" | "text"
  text: string
  state: "streaming" | "completed" | "discarded"
  startedAt: number
  endedAt?: number
  lastEventSeq?: number
}

/** Rebuild public message parts from the same durable events used by SSE replay. */
export function assistantPartsForRequest(requestId: string): PublicAssistantPart[] {
  const taskId = SessionCommandRepo.get(requestId)?.taskId
  if (!taskId) return []
  const parts = new Map<string, PublicAssistantPart>()
  let cursor = 0
  while (true) {
    const events = RunEventRepo.listAfter(taskId, cursor, 1_000)
    for (const event of events) {
      cursor = Math.max(cursor, event.seq)
      if (event.type !== "assistant-part" || !event.payload || typeof event.payload !== "object") continue
      const payload = event.payload as Record<string, unknown>
      if (payload.requestId !== requestId) continue
      applyPart(parts, payload, event.seq, event.createdAt)
    }
    if (events.length < 1_000) break
  }
  return [...parts.values()].filter((part) => part.state !== "discarded")
}

function applyPart(
  parts: Map<string, PublicAssistantPart>,
  payload: Record<string, unknown>,
  seq: number,
  createdAt: number,
): void {
  const id = typeof payload.partId === "string" ? payload.partId : ""
  const type = payload.partType === "reasoning" || payload.partType === "text" ? payload.partType : null
  const status = payload.status
  if (!id || !type || !["start", "delta", "end"].includes(String(status))) return
  const timestamp = Number(payload.timestamp) || createdAt
  const current = parts.get(id) ?? {
    id,
    type,
    text: "",
    state: "streaming",
    startedAt: timestamp,
  }
  if (current.lastEventSeq !== undefined && seq <= current.lastEventSeq) return
  if (status === "delta") current.text += String(payload.text ?? "")
  if (status === "end") {
    current.state = payload.outcome === "discarded" ? "discarded" : "completed"
    current.endedAt = Math.max(current.startedAt, timestamp)
  }
  current.lastEventSeq = seq
  parts.set(id, current)
}
