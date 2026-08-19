import type { LogLine } from "./store"

export interface PersistedBuildLogEvent {
  runId: string
  sessionId: string
  seq: number
  type: string
  payload: unknown
  createdAt: number
}

export function projectBuildLogEvents(events: PersistedBuildLogEvent[]): LogLine[] {
  return events.flatMap((event) => {
    if (event.type !== "tool-stream" || !event.payload || typeof event.payload !== "object") return []
    const payload = event.payload as Record<string, unknown>
    if (payload.target !== "build" || typeof payload.text !== "string") return []
    return [{
      id: `${event.runId}:${event.seq}`,
      text: payload.text,
      type: payload.type === "stderr" ? "error" as const : "info" as const,
      timestamp: event.createdAt,
    }]
  })
}
