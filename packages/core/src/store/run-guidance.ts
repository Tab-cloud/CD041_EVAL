import { randomUUID } from "node:crypto"
import { getDb } from "./database.ts"
import type { TaskRunStatus } from "./task-run.ts"

export interface RunGuidanceAttachment {
  name: string
  mime: string
  kind: "image" | "text" | "binary"
  dataUrl?: string
  content?: string
}

export interface RunGuidanceView {
  requestId: string
  rootRunId: string
  sessionId: string
  message: string
  attachments: RunGuidanceAttachment[]
  state: "pending" | "applied" | "rejected"
  error?: string
  createdAt: number
  appliedAt?: number
}

interface RunGuidanceRow {
  request_id: string
  root_run_id: string
  session_id: string
  message: string
  attachments: string
  state: RunGuidanceView["state"]
  error: string | null
  created_at: number
  applied_at: number | null
}

interface GuidanceTaskRow {
  id: string
  session_id: string
  agent_id: string
  status: TaskRunStatus
}

const ACTIVE_TASK_STATES = new Set<TaskRunStatus>([
  "queued",
  "running",
  "waiting-approval",
  "waiting-delegation",
  "safety-quarantine",
])

export class RunGuidanceConflictError extends Error {
  constructor(readonly requestId: string) {
    super("requestId 已绑定到另一条任务引导")
    this.name = "RunGuidanceConflictError"
  }
}

export class RunGuidanceAdmissionError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
    this.name = "RunGuidanceAdmissionError"
  }
}

/**
 * Durable same-run guidance inbox.
 *
 * Admission and the visible user message share one immediate transaction with
 * the task-state check. A terminal task can therefore never accept guidance
 * that would silently become an unrelated successor command.
 */
export const RunGuidanceRepo = {
  submit(input: {
    requestId: string
    rootRunId: string
    sessionId: string
    message: string
    attachments?: RunGuidanceAttachment[]
    createdAt?: number
  }): { guidance: RunGuidanceView; inserted: boolean } {
    const db = getDb()
    return db.transaction(() => {
      const existing = db.query(
        "SELECT * FROM run_guidance WHERE request_id = ?",
      ).get(input.requestId) as RunGuidanceRow | null
      const attachments = normalizeAttachments(input.attachments)
      const attachmentsJson = JSON.stringify(attachments)
      if (existing) {
        if (existing.root_run_id !== input.rootRunId
          || existing.session_id !== input.sessionId
          || existing.message !== input.message
          || existing.attachments !== attachmentsJson) {
          throw new RunGuidanceConflictError(input.requestId)
        }
        return { guidance: toView(existing), inserted: false }
      }

      const task = db.query(
        "SELECT id, session_id, agent_id, status FROM task_runs WHERE id = ?",
      ).get(input.rootRunId) as GuidanceTaskRow | null
      if (!task || task.session_id !== input.sessionId) {
        throw new RunGuidanceAdmissionError("当前任务不存在或不属于这个会话", 404)
      }
      if (!ACTIVE_TASK_STATES.has(task.status)) {
        throw new RunGuidanceAdmissionError("当前任务已经结束，无法再引导；可作为新消息发送", 409)
      }

      const createdAt = input.createdAt ?? Date.now()
      db.run(
        `INSERT INTO run_guidance
         (request_id, root_run_id, session_id, message, attachments, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [input.requestId, input.rootRunId, input.sessionId, input.message, attachmentsJson, createdAt],
      )
      const nextSeq = db.query(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?",
      ).get(input.sessionId) as { seq: number }
      db.run(
        `INSERT INTO messages
         (id, session_id, request_id, role, content, agent_id, tool_calls, tool_results, seq, timestamp)
         VALUES (?, ?, ?, 'user', ?, ?, NULL, NULL, ?, ?)`,
        [
          `msg-${randomUUID()}`,
          input.sessionId,
          input.requestId,
          input.message,
          task.agent_id,
          nextSeq.seq,
          createdAt,
        ],
      )
      db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [createdAt, input.sessionId])
      return {
        inserted: true,
        guidance: {
          requestId: input.requestId,
          rootRunId: input.rootRunId,
          sessionId: input.sessionId,
          message: input.message,
          attachments,
          state: "pending" as const,
          createdAt,
        },
      }
    }).immediate()
  },

  consumePending(rootRunId: string): RunGuidanceView[] {
    const db = getDb()
    return db.transaction(() => {
      const rows = db.query(
        `SELECT * FROM run_guidance
         WHERE root_run_id = ? AND state = 'pending'
         ORDER BY created_at ASC, request_id ASC`,
      ).all(rootRunId) as RunGuidanceRow[]
      if (rows.length === 0) return []
      const appliedAt = Date.now()
      for (const row of rows) {
        db.run(
          `UPDATE run_guidance SET state = 'applied', applied_at = ?
           WHERE request_id = ? AND state = 'pending'`,
          [appliedAt, row.request_id],
        )
      }
      return rows.map((row) => toView({
        ...row,
        state: "applied",
        applied_at: appliedAt,
      }))
    }).immediate()
  },

  rejectPending(rootRunId: string, error: string): number {
    return getDb().query(
      `UPDATE run_guidance
       SET state = 'rejected', error = ?, applied_at = ?
       WHERE root_run_id = ? AND state = 'pending'`,
    ).run(error.slice(0, 1_000), Date.now(), rootRunId).changes
  },

  list(rootRunId: string): RunGuidanceView[] {
    return (getDb().query(
      "SELECT * FROM run_guidance WHERE root_run_id = ? ORDER BY created_at ASC, request_id ASC",
    ).all(rootRunId) as RunGuidanceRow[]).map(toView)
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM run_guidance WHERE session_id = ?", [sessionId])
  },
}

function normalizeAttachments(value: RunGuidanceAttachment[] | undefined): RunGuidanceAttachment[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 10).map((attachment) => ({
    name: String(attachment.name).slice(0, 255),
    mime: String(attachment.mime).slice(0, 100),
    kind: attachment.kind === "image" || attachment.kind === "text" ? attachment.kind : "binary",
    ...(typeof attachment.dataUrl === "string" ? { dataUrl: attachment.dataUrl } : {}),
    ...(typeof attachment.content === "string" ? { content: attachment.content } : {}),
  }))
}

function toView(row: RunGuidanceRow): RunGuidanceView {
  let attachments: RunGuidanceAttachment[] = []
  try { attachments = normalizeAttachments(JSON.parse(row.attachments)) } catch {}
  return {
    requestId: row.request_id,
    rootRunId: row.root_run_id,
    sessionId: row.session_id,
    message: row.message,
    attachments,
    state: row.state,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
  }
}
