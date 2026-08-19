import { appendFile, rename, stat, unlink } from "node:fs/promises"
import {
  ensureEvalDataDir,
  EVAL_DIAGNOSTIC_LOG_BACKUP_PATH,
  EVAL_DIAGNOSTIC_LOG_PATH,
} from "../store/runtime-data-paths.ts"
import { stringifyBoundedJson } from "../store/bounded-json.ts"

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const MAX_ENTRY_BYTES = 32 * 1024

export interface DiagnosticFileLogEntry {
  timestamp: string
  level: "debug" | "info" | "warning" | "error"
  eventType: string
  message: string
  sessionId?: string
  runId?: string
  requestId?: string
  parentRunId?: string
  agentId?: string
  data?: Record<string, unknown>
}

let writeTail = Promise.resolve()
let failureReported = false

/**
 * Non-blocking JSONL diagnostic sink. The SQLite event log remains the source
 * of truth; log.txt is an operator-friendly mirror for failures that prevent
 * the UI or database inspection path from being used.
 */
export function appendDiagnosticFileLog(entry: DiagnosticFileLogEntry): void {
  writeTail = writeTail
    .then(async () => {
      ensureEvalDataDir()
      const line = `${stringifyBoundedJson({ version: 1, ...entry }, MAX_ENTRY_BYTES)}\n`
      await rotateIfNeeded(Buffer.byteLength(line))
      await appendFile(EVAL_DIAGNOSTIC_LOG_PATH, line, "utf8")
      failureReported = false
    })
    .catch((error) => {
      if (!failureReported) {
        failureReported = true
        console.error(`[diagnostic-file-log] ${error instanceof Error ? error.message : String(error)}`)
      }
    })
}

/** Test/shutdown barrier; normal execution never waits on file I/O. */
export async function flushDiagnosticFileLog(): Promise<void> {
  await writeTail
}

async function rotateIfNeeded(incomingBytes: number): Promise<void> {
  const configured = Number.parseInt(process.env.EVAL_LOG_MAX_BYTES ?? "", 10)
  const maxBytes = Number.isFinite(configured) && configured >= 64 * 1024
    ? configured
    : DEFAULT_MAX_BYTES
  let currentBytes = 0
  try {
    currentBytes = (await stat(EVAL_DIAGNOSTIC_LOG_PATH)).size
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  if (currentBytes + incomingBytes <= maxBytes) return

  try {
    await unlink(EVAL_DIAGNOSTIC_LOG_BACKUP_PATH)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  try {
    await rename(EVAL_DIAGNOSTIC_LOG_PATH, EVAL_DIAGNOSTIC_LOG_BACKUP_PATH)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "ENOENT")
}
