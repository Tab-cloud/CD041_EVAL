import { getDb } from "./database"
import { RuntimeOwnerLeaseRepo } from "./runtime-owner-lease"

export type SessionCommandState =
  | "pending"
  | "processing"
  | "accepted"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"

export interface SessionCommandView {
  requestId: string
  sessionId: string
  sessionSeq: number
  payload: string
  state: SessionCommandState
  ownerToken?: string
  ownerEpoch?: string
  taskId?: string
  error?: string
  createdAt: number
  claimedAt?: number
  completedAt?: number
}

export interface ConversationBranchTarget {
  requestId?: string
  seq?: number
}

interface SessionCommandRow {
  request_id: string
  session_id: string
  session_seq: number
  payload: string
  state: SessionCommandState
  owner_token: string | null
  owner_epoch: string | null
  task_id: string | null
  error: string | null
  created_at: number
  claimed_at: number | null
  completed_at: number | null
}

const TERMINAL_STATES: SessionCommandState[] = ["blocked", "completed", "failed", "cancelled"]

export class SessionCommandConflictError extends Error {
  constructor(readonly requestId: string) {
    super("requestId 已绑定到另一条会话命令")
    this.name = "SessionCommandConflictError"
  }
}

export class SessionCommandBranchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionCommandBranchError"
  }
}

export class SessionCommandBranchBusyError extends SessionCommandBranchError {
  constructor() {
    super("当前会话仍有执行中或排队中的任务，暂时不能替换历史回复")
    this.name = "SessionCommandBranchBusyError"
  }
}

export const SessionCommandRepo = {
  /**
   * Insert a command exactly once. Session sequence allocation and insertion
   * share one transaction, so concurrent HTTP requests have a durable FIFO
   * order before any conversation history is read.
   */
  enqueue(input: {
    requestId: string
    sessionId: string
    payload: string
    createdAt?: number
  }): { command: SessionCommandView; inserted: boolean } {
    const db = getDb()
    return db.transaction(() => {
      const existing = db.query(
        "SELECT * FROM session_commands WHERE request_id = ?",
      ).get(input.requestId) as SessionCommandRow | null
      if (existing) {
        if (existing.session_id !== input.sessionId || existing.payload !== input.payload) {
          throw new SessionCommandConflictError(input.requestId)
        }
        return { command: toView(existing), inserted: false }
      }

      const branchFrom = parseConversationBranch(input.payload)
      if (branchFrom) applyConversationBranch(db, input.sessionId, branchFrom)

      const next = db.query(
        "SELECT COALESCE(MAX(session_seq), 0) + 1 AS seq FROM session_commands WHERE session_id = ?",
      ).get(input.sessionId) as { seq: number }
      const createdAt = input.createdAt ?? Date.now()
      db.run(
        `INSERT INTO session_commands
         (request_id, session_id, session_seq, payload, state, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [input.requestId, input.sessionId, next.seq, input.payload, createdAt],
      )
      return {
        inserted: true,
        command: {
          requestId: input.requestId,
          sessionId: input.sessionId,
          sessionSeq: next.seq,
          payload: input.payload,
          state: "pending" as const,
          createdAt,
        },
      }
    }).immediate()
  },

  get(requestId: string): SessionCommandView | null {
    const row = getDb().query(
      "SELECT * FROM session_commands WHERE request_id = ?",
    ).get(requestId) as SessionCommandRow | null
    return row ? toView(row) : null
  },

  /**
   * Acquire only the oldest non-terminal command in a session. The conditional
   * update is the ownership boundary for duplicate/retried HTTP requests.
   */
  tryClaim(requestId: string, ownerToken: string, ownerEpoch: string): SessionCommandView | null {
    const db = getDb()
    return db.transaction(() => {
      const now = Date.now()
      if (!RuntimeOwnerLeaseRepo.isActive(ownerEpoch, now)) return null
      const row = db.query(
        "SELECT * FROM session_commands WHERE request_id = ?",
      ).get(requestId) as SessionCommandRow | null
      if (!row) return null
      if (row.state === "processing" && row.owner_token === ownerToken) return toView(row)
      if (row.state !== "pending") return null
      const earlier = db.query(
        `SELECT 1 FROM session_commands
         WHERE session_id = ? AND session_seq < ?
           AND state NOT IN ('blocked', 'completed', 'failed', 'cancelled')
         LIMIT 1`,
      ).get(row.session_id, row.session_seq)
      if (earlier) return null
      const result = db.query(
        `UPDATE session_commands
         SET state = 'processing', owner_token = ?, owner_epoch = ?, claimed_at = ?
         WHERE request_id = ? AND state = 'pending'`,
      ).run(ownerToken, ownerEpoch, now, requestId)
      if (result.changes !== 1) return null
      return {
        ...toView(row),
        state: "processing" as const,
        ownerToken,
        ownerEpoch,
        claimedAt: now,
      }
    }).immediate()
  },

  bindTask(requestId: string, ownerToken: string, taskId: string): SessionCommandView | null {
    const now = Date.now()
    const result = getDb().query(
      `UPDATE session_commands
       SET state = 'accepted', task_id = ?
       WHERE request_id = ? AND state = 'processing' AND owner_token = ?
         AND EXISTS (
           SELECT 1 FROM runtime_owner_leases
           WHERE owner_epoch = session_commands.owner_epoch
             AND lease_expires_at > ?
         )`,
    ).run(taskId, requestId, ownerToken, now)
    return result.changes === 1 ? this.get(requestId) : null
  },

  /**
   * Finish an unbound command only while the caller still owns a live lease.
   * This is the fencing boundary that prevents a suspended, expired worker
   * from waking up and overwriting a replacement owner's command state.
   */
  finishOwned(
    requestId: string,
    ownerToken: string,
    state: Extract<SessionCommandState, "blocked" | "completed" | "failed" | "cancelled">,
    error?: string,
  ): SessionCommandView | null {
    const now = Date.now()
    const result = getDb().query(
      `UPDATE session_commands
       SET state = ?, error = ?, completed_at = ?, owner_token = NULL
       WHERE request_id = ? AND state = 'processing' AND owner_token = ?
         AND EXISTS (
           SELECT 1 FROM runtime_owner_leases
           WHERE owner_epoch = session_commands.owner_epoch
             AND lease_expires_at > ?
         )`,
    ).run(
      state,
      error?.slice(0, 4_000) ?? null,
      now,
      requestId,
      ownerToken,
      now,
    )
    return result.changes === 1 ? this.get(requestId) : null
  },

  /**
   * Close a command that was already bound to a root task, but only while the
   * runtime epoch that admitted it still owns a live lease and the task
   * identity still matches. The dispatcher reconciler uses this boundary for
   * missing/orphaned roots without giving a stale process authority over a
   * replacement owner.
   */
  finishAcceptedOwned(
    requestId: string,
    ownerEpoch: string,
    taskId: string,
    state: Extract<SessionCommandState, "blocked" | "completed" | "failed" | "cancelled">,
    error?: string,
  ): SessionCommandView | null {
    const now = Date.now()
    const result = getDb().query(
      `UPDATE session_commands
       SET state = ?, error = ?, completed_at = ?, owner_token = NULL
       WHERE request_id = ? AND state = 'accepted'
         AND owner_epoch = ? AND task_id = ?
         AND EXISTS (
           SELECT 1 FROM runtime_owner_leases
           WHERE owner_epoch = session_commands.owner_epoch
             AND lease_expires_at > ?
         )`,
    ).run(
      state,
      error?.slice(0, 4_000) ?? null,
      now,
      requestId,
      ownerEpoch,
      taskId,
      now,
    )
    return result.changes === 1 ? this.get(requestId) : null
  },

  finish(
    requestId: string,
    state: Extract<SessionCommandState, "blocked" | "completed" | "failed" | "cancelled">,
    error?: string,
  ): SessionCommandView | null {
    getDb().run(
      `UPDATE session_commands
       SET state = ?, error = ?, completed_at = ?, owner_token = NULL
       WHERE request_id = ? AND state NOT IN ('blocked', 'completed', 'failed', 'cancelled')`,
      [state, error?.slice(0, 4_000) ?? null, Date.now(), requestId],
    )
    return this.get(requestId)
  },

  finishPending(
    requestId: string,
    state: Extract<SessionCommandState, "failed" | "cancelled">,
    error?: string,
  ): SessionCommandView | null {
    const result = getDb().query(
      `UPDATE session_commands
       SET state = ?, error = ?, completed_at = ?
       WHERE request_id = ? AND state = 'pending'`,
    ).run(
      state,
      error?.slice(0, 4_000) ?? null,
      Date.now(),
      requestId,
    )
    return result.changes === 1 ? this.get(requestId) : null
  },

  releaseClaim(requestId: string, ownerToken: string): boolean {
    return getDb().query(
      `UPDATE session_commands
       SET state = 'pending', owner_token = NULL, owner_epoch = NULL, claimed_at = NULL
       WHERE request_id = ? AND state = 'processing' AND owner_token = ?`,
    ).run(requestId, ownerToken).changes === 1
  },

  /**
   * Process epochs are generated once per backend process and backed by a
   * renewable lease. A different epoch alone is not proof of death: another
   * backend may be actively sharing this database. Recovery is allowed only
   * after the recorded owner's lease has expired or been explicitly retired.
   */
  recoverForProcess(requestId: string, processEpoch: string): SessionCommandView | null {
    const db = getDb()
    return db.transaction(() => {
      const row = db.query(
        "SELECT * FROM session_commands WHERE request_id = ?",
      ).get(requestId) as SessionCommandRow | null
      if (!row || !row.owner_epoch || row.owner_epoch === processEpoch) return row ? toView(row) : null
      if (RuntimeOwnerLeaseRepo.isActive(row.owner_epoch)) return toView(row)
      if (row.state === "processing") {
        db.run(
          `UPDATE session_commands
           SET state = 'pending', owner_token = NULL, owner_epoch = NULL, claimed_at = NULL
           WHERE request_id = ? AND state = 'processing' AND owner_epoch = ?`,
          [requestId, row.owner_epoch],
        )
        return this.get(requestId)
      }
      if (row.state !== "accepted") return toView(row)

      const task = row.task_id
        ? db.query("SELECT status, error FROM task_runs WHERE id = ?").get(row.task_id) as {
            status: string
            error: string | null
          } | null
        : null
      const completedAt = Date.now()
      const nextState: Extract<SessionCommandState, "blocked" | "completed" | "failed" | "cancelled"> =
        task?.status === "completed" ? "completed"
          : task?.status === "cancelled" ? "cancelled"
            : task?.status === "blocked" ? "blocked"
              : "failed"
      const error = nextState === "completed"
        ? null
        : task?.error || (task
          ? `服务重启时根任务仍处于 ${task.status}，已关闭孤立命令`
          : "服务重启后找不到命令绑定的根任务")
      db.run(
        `UPDATE session_commands
         SET state = ?, error = ?, completed_at = ?, owner_token = NULL
         WHERE request_id = ? AND state = 'accepted' AND owner_epoch = ?`,
        [nextState, error, completedAt, requestId, row.owner_epoch],
      )
      return this.get(requestId)
    }).immediate()
  },

  listPending(sessionId?: string): SessionCommandView[] {
    const rows = sessionId
      ? getDb().query(
          `SELECT * FROM session_commands
           WHERE session_id = ? AND state NOT IN ('blocked', 'completed', 'failed', 'cancelled')
           ORDER BY session_seq ASC`,
        ).all(sessionId)
      : getDb().query(
          `SELECT * FROM session_commands
           WHERE state NOT IN ('blocked', 'completed', 'failed', 'cancelled')
           ORDER BY created_at ASC, session_id ASC, session_seq ASC`,
        ).all()
    return (rows as SessionCommandRow[]).map(toView)
  },

  listBySession(sessionId: string, limit = 100): SessionCommandView[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 100
    const rows = getDb().query(
      `SELECT * FROM session_commands
       WHERE session_id = ?
       ORDER BY session_seq DESC
       LIMIT ?`,
    ).all(sessionId, safeLimit) as SessionCommandRow[]
    return rows.map(toView)
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM session_commands WHERE session_id = ?", [sessionId])
  },
}

export function isTerminalSessionCommand(state: SessionCommandState): boolean {
  return TERMINAL_STATES.includes(state)
}

function parseConversationBranch(payload: string): ConversationBranchTarget | null {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(payload)
    parsed = value && typeof value === "object" ? value as Record<string, unknown> : {}
  } catch {
    return null
  }
  if (parsed.branchFrom === undefined) return null
  if (!parsed.branchFrom || typeof parsed.branchFrom !== "object" || Array.isArray(parsed.branchFrom)) {
    throw new SessionCommandBranchError("历史消息分支标识无效")
  }
  const raw = parsed.branchFrom as Record<string, unknown>
  const requestId = typeof raw.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(raw.requestId)
    ? raw.requestId
    : undefined
  const seq = Number.isSafeInteger(raw.seq) && Number(raw.seq) > 0
    ? Number(raw.seq)
    : undefined
  if (!requestId && !seq) throw new SessionCommandBranchError("历史消息分支标识无效")
  return { requestId, seq }
}

function applyConversationBranch(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  target: ConversationBranchTarget,
): void {
  const message = target.requestId
    ? db.query(
        `SELECT request_id, seq FROM messages
         WHERE session_id = ? AND request_id = ? AND role = 'user'`,
      ).get(sessionId, target.requestId) as { request_id: string | null; seq: number } | null
    : db.query(
        `SELECT request_id, seq FROM messages
         WHERE session_id = ? AND seq = ? AND role = 'user'`,
      ).get(sessionId, target.seq!) as { request_id: string | null; seq: number } | null
  if (!message || (target.seq !== undefined && message.seq !== target.seq)) {
    throw new SessionCommandBranchError("要编辑的历史消息不存在或已经被替换")
  }

  const activeCommand = db.query(
    `SELECT 1
     FROM session_commands AS command
     LEFT JOIN task_runs AS task ON task.id = command.task_id
     WHERE command.session_id = ?
       AND (
         command.state IN ('pending', 'processing')
         OR (command.state = 'accepted' AND (
           task.id IS NULL
           OR task.status NOT IN ('blocked', 'completed', 'failed', 'cancelled', 'interrupted')
         ))
       )
     LIMIT 1`,
  ).get(sessionId)
  const activeTask = db.query(
    `SELECT 1 FROM task_runs
     WHERE session_id = ?
       AND status NOT IN ('blocked', 'completed', 'failed', 'cancelled', 'interrupted')
     LIMIT 1`,
  ).get(sessionId)
  if (activeCommand || activeTask) throw new SessionCommandBranchBusyError()

  db.run("DELETE FROM messages WHERE session_id = ? AND seq >= ?", [sessionId, message.seq])
  db.run(
    "UPDATE sessions SET compact_summary = NULL, compact_at = NULL, updated_at = ? WHERE id = ?",
    [Date.now(), sessionId],
  )
}

function toView(row: SessionCommandRow): SessionCommandView {
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    sessionSeq: row.session_seq,
    payload: row.payload,
    state: row.state,
    ownerToken: row.owner_token ?? undefined,
    ownerEpoch: row.owner_epoch ?? undefined,
    taskId: row.task_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    claimedAt: row.claimed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  }
}
