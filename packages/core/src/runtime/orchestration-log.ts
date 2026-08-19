import { redactSensitiveData } from "./sensitive-data.ts"
import { OrchestrationLogRepo, type OrchestrationLogLevel } from "../store/orchestration-log.ts"
import { appendDiagnosticFileLog } from "./diagnostic-file-log.ts"

export interface OrchestrationLogInput {
  sessionId: string
  runId: string
  parentRunId?: string
  agentId?: string
  eventType: string
  level?: OrchestrationLogLevel
  message: string
  data?: Record<string, unknown>
}

/** Durable diagnostic event. Logging failure must never change execution state. */
export function logOrchestrationEvent(input: OrchestrationLogInput): void {
  try {
    const safeData = redactSensitiveData(input.data ?? {})
    const safeMessage = redactSensitiveData(input.message)
    const entry = OrchestrationLogRepo.insert({
      ...input,
      message: typeof safeMessage === "string" ? safeMessage : "诊断事件",
      level: input.level ?? "info",
      data: isRecord(safeData) ? safeData : {},
    })
    appendDiagnosticFileLog({
      timestamp: new Date(entry.createdAt).toISOString(),
      eventType: entry.eventType,
      sessionId: entry.sessionId,
      runId: entry.runId,
      parentRunId: entry.parentRunId,
      agentId: entry.agentId,
      level: entry.level,
      message: entry.message,
      data: entry.data,
    })
    // Durable logs are the source of truth. Synchronous stdout mirroring is an
    // explicit diagnostic mode because it can block high-volume orchestration
    // and exposes internal coordination in the desktop terminal.
    if (process.env.EVAL_ORCHESTRATION_LOG_STDOUT === "1") {
      console.log(`[orchestration] ${JSON.stringify({
        timestamp: new Date(entry.createdAt).toISOString(), eventType: entry.eventType,
        sessionId: entry.sessionId, runId: entry.runId, parentRunId: entry.parentRunId,
        agentId: entry.agentId, level: entry.level, message: entry.message, data: entry.data,
      })}`)
    }
  } catch (error) {
    console.error(`[orchestration-log] ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
