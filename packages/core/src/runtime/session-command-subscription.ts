import { RunEventRepo } from "../store/run-event"
import { isTerminalSessionCommand, SessionCommandRepo } from "../store/session-command"
import { TaskRunRepo } from "../store/task-run"
import {
  projectPublicRunEvent,
  projectPublicRunEventRecord,
} from "./public-run-event.ts"
import type { RuntimeEventType } from "./runtime-protocol.ts"

const HEARTBEAT_MS = 8_000
const RUN_EVENT_PAGE_SIZE = 500
const TERMINAL_PUBLICATION_GRACE_MS = 2_000

export function commandSubscriptionResponse(
  requestId: string,
  sessionId: string,
  headers: Record<string, string>,
): Response {
  let cancelled = false
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let cursor = 0
      let taskId = ""
      let sawDone = false
      let terminalObservedAt = 0
      const emitProjected = (event: RuntimeEventType, data: unknown, id?: number) => {
        if (cancelled) return
        try {
          controller.enqueue(encoder.encode(
            `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          ))
        } catch {
          cancelled = true
        }
      }
      const emit = (event: RuntimeEventType, data: unknown, id?: number) => {
        if (cancelled) return
        const candidate = event === "done" && data && typeof data === "object"
          ? { ...(data as Record<string, unknown>), requestId }
          : data
        const projected = projectPublicRunEvent(event, candidate)
        if (!projected) return
        emitProjected(projected.type, projected.payload, id)
      }
      const heartbeat = setInterval(() => emit("heartbeat", { timestamp: Date.now() }), HEARTBEAT_MS)
      try {
        while (!cancelled) {
          const command = SessionCommandRepo.get(requestId)
          if (!command) {
            emit("error", { message: "持久命令不存在" })
            emit("done", { requestId, sessionId, status: "failed", error: "持久命令不存在" })
            break
          }
          if (command.taskId) {
            if (!taskId) {
              taskId = command.taskId
              emit("session", { sessionId, taskId })
            }
            const events = RunEventRepo.listAfter(taskId, cursor, RUN_EVENT_PAGE_SIZE)
            for (const event of events) {
              const projected = projectPublicRunEventRecord(event, { requestId })
              if (projected) emitProjected(projected.type, projected.payload, event.seq)
              cursor = Math.max(cursor, event.seq)
              if (projected?.type === "done") sawDone = true
            }
            if (sawDone) break
            if (isTerminalSessionCommand(command.state)) {
              terminalObservedAt ||= Date.now()
              const terminalAge = Date.now() - (command.completedAt ?? terminalObservedAt)
              // A terminal command releases the execution lane, but it is not
              // the presentation-stream barrier. Drain every durable page and
              // give the producer a bounded window to append its authoritative
              // `done` record before falling back to a synthesized terminal.
              if (events.length >= RUN_EVENT_PAGE_SIZE
                || terminalAge < TERMINAL_PUBLICATION_GRACE_MS) {
                if (events.length < RUN_EVENT_PAGE_SIZE) {
                  await new Promise((resolve) => setTimeout(resolve, 50))
                }
                continue
              }
            }
          }
          if (isTerminalSessionCommand(command.state)) {
            if (!sawDone) {
              const task = command.taskId ? TaskRunRepo.get(command.taskId) : null
              if (command.state === "failed" && command.error) emit("error", { message: command.error })
              emit("done", {
                requestId,
                sessionId,
                taskId: command.taskId,
                status: task?.status ?? command.state,
                result: task?.result,
                error: task?.error ?? command.error,
              })
            }
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      } finally {
        clearInterval(heartbeat)
        try { controller.close() } catch {}
      }
    },
    cancel() {
      cancelled = true
    },
  })
  return new Response(stream, {
    headers: {
      ...headers,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  })
}
