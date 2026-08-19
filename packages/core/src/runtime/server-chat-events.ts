import { BuildLogRepo } from "../store/build-log.ts"
import { RunEventRepo } from "../store/run-event.ts"
import { logOrchestrationEvent } from "./orchestration-log.ts"
import {
  projectPublicRunEvent,
  PUBLIC_RUN_EVENT_PROJECTION_VERSION,
} from "./public-run-event.ts"
import type { RuntimeEventType } from "./runtime-protocol.ts"

export function createRunEventEmitter(input: {
  controller: { enqueue(chunk: Uint8Array): void }
  runId: string
  sessionId: string
  requestId?: string
  agentId: string
  isSseAborted: () => boolean
}): (event: RuntimeEventType, data: unknown) => void {
  const encoder = new TextEncoder()
  let eventLogDegraded = false
  const markEventLogDegraded = (store: "run-events" | "build-log", error: unknown) => {
    if (eventLogDegraded) return
    eventLogDegraded = true
    try {
      logOrchestrationEvent({
        sessionId: input.sessionId,
        runId: input.runId,
        agentId: input.agentId,
        eventType: "event-log.degraded",
        level: "error",
        message: "实时事件仍在执行，但持久回放通道发生故障",
        data: {
          store,
          error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
        },
      })
    } catch (loggingError) {
      console.error("[event-log.degraded]", loggingError)
    }
  }
  return (event, data) => {
    const candidateData = event === "done" && data && typeof data === "object"
      ? {
          ...(data as Record<string, unknown>),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(eventLogDegraded
            ? { eventLog: { status: "degraded", replayComplete: false } }
            : {}),
        }
      : event === "assistant-part" && data && typeof data === "object"
        ? {
            ...(data as Record<string, unknown>),
            ...(input.requestId ? { requestId: input.requestId } : {}),
          }
        : data
    const projected = projectPublicRunEvent(event, candidateData)
    if (!projected) return
    const publicEvent = projected.type
    const visibleData = projected.payload
    let sequence: number | undefined
    if (isDurableRunEvent(publicEvent)) {
      try {
        sequence = RunEventRepo.append(
          input.runId,
          input.sessionId,
          publicEvent,
          visibleData,
          PUBLIC_RUN_EVENT_PROJECTION_VERSION,
        ).seq
      }
      catch (error) { markEventLogDegraded("run-events", error) }
    }
    if (publicEvent === "tool-stream" && sequence && isBuildStreamPayload(visibleData)) {
      try { BuildLogRepo.append(input.runId, input.sessionId, sequence, visibleData) }
      catch (error) { markEventLogDegraded("build-log", error) }
    }
    if (publicEvent === "execution-blocked" || publicEvent === "done") {
      const publicPayload = visibleData && typeof visibleData === "object"
        ? visibleData as Record<string, unknown>
        : {}
      logOrchestrationEvent({
        sessionId: input.sessionId,
        runId: input.runId,
        agentId: input.agentId,
        eventType: `public-event.${publicEvent}`,
        level: publicEvent === "execution-blocked" ? "warning" : "info",
        message: publicEvent === "execution-blocked"
          ? "运行进入可恢复阻塞终态"
          : "运行已发布终态事件",
        data: {
          requestId: input.requestId,
          sequence,
          projectionVersion: PUBLIC_RUN_EVENT_PROJECTION_VERSION,
          problemCode: publicPayload.code,
          status: publicPayload.status,
        },
      })
    }
    // 客户端断线只停止网络发送；后台任务仍必须持久化事件，供恢复和历史回放。
    if (input.isSseAborted()) return
    try {
      input.controller.enqueue(encoder.encode(`${sequence ? `id: ${sequence}\n` : ""}event: ${publicEvent}\ndata: ${JSON.stringify(visibleData)}\n\n`))
    } catch { /* controller 已关闭（客户端断开），忽略 */ }
  }
}

export function isDurableRunEvent(event: RuntimeEventType): boolean {
  // The dispatcher consumes the worker's private Response. Public subscribers
  // replay one authoritative per-run event channel. Heartbeats are regenerated
  // for each subscriber and are the only non-durable event.
  return event !== "heartbeat"
}

export function isBuildStreamPayload(value: unknown): value is {
  target: "build"
  text: string
  type: "stdout" | "stderr" | "info"
} {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return record.target === "build"
    && typeof record.text === "string"
    && ["stdout", "stderr", "info"].includes(String(record.type))
}
