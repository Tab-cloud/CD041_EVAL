import { getDb } from "./database"
import { syncSessionCommandTerminal } from "./session-command-terminal.ts"

export type TaskRunStatus = "queued" | "running" | "cancelling" | "waiting-approval" | "waiting-delegation" | "safety-quarantine" | "blocked" | "completed" | "failed" | "cancelled" | "interrupted"

export interface TaskRunView {
  id: string
  parentRunId?: string
  requestId?: string
  sessionId: string
  agentId: string
  priority: number
  status: TaskRunStatus
  message: string
  workingDir: string
  type: "chat" | "compile" | "flash" | "background"
  scope?: string
  effort?: string
  modelId?: string
  retryOf?: string
  result?: string
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
}

export interface SafetyBarrierView extends TaskRunView {
  resourceClaims: { reads: string[]; writes: string[] }
}

export interface TaskRunCreateResult {
  created: boolean
  task: TaskRunView
}

interface TaskRunRow {
  id: string
  parent_run_id: string | null
  request_id: string | null
  session_id: string
  agent_id: string
  priority: number
  status: TaskRunStatus
  message: string
  working_dir: string
  task_type: TaskRunView["type"]
  scope: string | null
  effort: string | null
  model_id: string | null
  retry_of: string | null
  result: string | null
  error: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
}

const MAX_TERMINAL_TASKS_PER_SESSION = 100
const MAX_RESULT_CHARS = 20_000

export const TaskRunRepo = {
  create(task: TaskRunView): TaskRunCreateResult {
    const db = getDb()
    return db.transaction(() => {
      if (task.requestId) {
        const existing = db.query(
          "SELECT * FROM task_runs WHERE request_id = ?",
        ).get(task.requestId) as TaskRunRow | null
        if (existing) return { created: false, task: toView(existing) }
      }

      db.run(
        `INSERT INTO task_runs
         (id, request_id, parent_run_id, session_id, agent_id, priority, status, message, working_dir, task_type,
          scope, effort, model_id, retry_of, result, error, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id, task.requestId ?? null, task.parentRunId ?? null,
          task.sessionId, task.agentId, task.priority, task.status,
          task.message.slice(0, 50_000), task.workingDir, task.type,
          task.scope ?? null, task.effort ?? null, task.modelId ?? null, task.retryOf ?? null,
          task.result?.slice(0, MAX_RESULT_CHARS) ?? null,
          task.error?.slice(0, 4_000) ?? null,
          task.createdAt, task.startedAt ?? null, task.completedAt ?? null,
        ],
      )
      // Retention must never evict live work. Keep every non-terminal task and
      // prune only old terminal history after a new row is durably created.
      db.run(
        `DELETE FROM task_runs
         WHERE session_id = ?
           AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
           AND id NOT IN (
             SELECT id FROM task_runs
             WHERE session_id = ?
               AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
             ORDER BY created_at DESC LIMIT ?
           )`,
        [task.sessionId, task.sessionId, MAX_TERMINAL_TASKS_PER_SESSION],
      )
      return { created: true, task }
    }).immediate()
  },

  update(task: TaskRunView): void {
    const db = getDb()
    db.transaction(() => {
      db.run(
        `UPDATE task_runs SET status = ?, started_at = ?, completed_at = ?, result = ?, error = ? WHERE id = ?`,
        [
          task.status, task.startedAt ?? null, task.completedAt ?? null,
          task.result?.slice(0, MAX_RESULT_CHARS) ?? null,
          task.error?.slice(0, 4_000) ?? null,
          task.id,
        ],
      )
      syncSessionCommandTerminal(db, task)
    }).immediate()
  },

  get(id: string): TaskRunView | null {
    const row = getDb().query("SELECT * FROM task_runs WHERE id = ?").get(id) as TaskRunRow | null
    return row ? toView(row) : null
  },

  getByRequestId(requestId: string): TaskRunView | null {
    const row = getDb().query("SELECT * FROM task_runs WHERE request_id = ?").get(requestId) as TaskRunRow | null
    return row ? toView(row) : null
  },

  /**
   * Persist the semantic continuation edge discovered after root admission.
   * Root ownership is established before model interpretation, so retry_of
   * cannot always be known at INSERT time. Binding it here makes later
   * attachment and objective recovery follow an explicit lineage instead of
   * guessing from session chronology.
   */
  bindRetryOf(id: string, retryOf: string): boolean {
    if (!id || !retryOf || id === retryOf) return false
    const db = getDb()
    return db.transaction(() => {
      const task = db.query(
        "SELECT session_id, retry_of FROM task_runs WHERE id = ?",
      ).get(id) as { session_id: string; retry_of: string | null } | null
      const parent = db.query(
        "SELECT session_id FROM task_runs WHERE id = ?",
      ).get(retryOf) as { session_id: string } | null
      if (!task || !parent || task.session_id !== parent.session_id) return false
      if (task.retry_of && task.retry_of !== retryOf) return false
      db.run("UPDATE task_runs SET retry_of = ? WHERE id = ?", [retryOf, id])
      return true
    }).immediate()
  },

  listBySession(sessionId: string, limit = 50): TaskRunView[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 500)) : 50
    const rows = getDb().query(
      "SELECT * FROM task_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(sessionId, safeLimit) as TaskRunRow[]
    return rows.map(toView)
  },

  listByParent(parentRunId: string): TaskRunView[] {
    const rows = getDb().query(
      "SELECT * FROM task_runs WHERE parent_run_id = ? ORDER BY created_at ASC",
    ).all(parentRunId) as TaskRunRow[]
    return rows.map(toView)
  },

  listRecent(limit = 20): TaskRunView[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 20
    const rows = getDb().query("SELECT * FROM task_runs ORDER BY created_at DESC LIMIT ?").all(safeLimit) as TaskRunRow[]
    return rows.map(toView)
  },

  /**
   * Rebuild scheduler resource barriers after a process restart. A delegated
   * writer remains authoritative while cleanup cannot be proven, so the
   * safety barrier must keep excluding conflicting work even though its
   * execution coroutine no longer exists.
   */
  listSafetyBarriers(): SafetyBarrierView[] {
    const rows = getDb().query(
      `SELECT task_runs.*, run_contracts.contract AS contract_json,
              workspace_change_sets.workspace AS change_workspace
       FROM task_runs
       LEFT JOIN run_contracts ON run_contracts.run_id = task_runs.id
       LEFT JOIN workspace_change_sets ON workspace_change_sets.run_id = task_runs.id
       WHERE task_runs.status = 'safety-quarantine'
       ORDER BY task_runs.created_at ASC`,
    ).all() as Array<TaskRunRow & { contract_json: string | null; change_workspace: string | null }>
    return rows.map((row) => {
      let resources: SafetyBarrierView["resourceClaims"] = { reads: [], writes: [] }
      try {
        if (!row.contract_json) throw new Error("missing durable contract")
        const parsed = JSON.parse(row.contract_json) as {
          resources?: { reads?: unknown; writes?: unknown }
        }
        resources = {
          reads: stringArray(parsed.resources?.reads),
          writes: stringArray(parsed.resources?.writes),
        }
      } catch {
        // Invalid durable contracts fail closed: the workspace-wide write
        // barrier prevents new mutations until an operator resolves the row.
        resources = {
          reads: [],
          writes: [row.change_workspace ? `${row.change_workspace.replaceAll("\\", "/")}/**` : "workspace:**"],
        }
      }
      return { ...toView(row), resourceClaims: resources }
    })
  },

  count(): number {
    return (getDb().query("SELECT COUNT(*) AS count FROM task_runs").get() as { count: number }).count
  },

  markUnfinishedInterrupted(): number {
    const unfinished = getDb().query(
      "SELECT COUNT(*) AS count FROM task_runs WHERE status IN ('queued', 'running', 'cancelling', 'waiting-approval', 'waiting-delegation')",
    ).get() as { count: number }
    if (unfinished.count > 0) {
      const now = Date.now()
      const reason = "应用退出或服务重启，任务执行被中断"
      const executionRows = getDb().query(
        `SELECT task_id, snapshot FROM execution_runs
         WHERE task_id IN (SELECT id FROM task_runs WHERE status IN ('queued', 'running', 'cancelling', 'waiting-approval', 'waiting-delegation'))`,
      ).all() as Array<{ task_id: string; snapshot: string }>
      for (const row of executionRows) {
        let snapshot: Record<string, unknown>
        try { snapshot = JSON.parse(row.snapshot) as Record<string, unknown> } catch { snapshot = {} }
        getDb().run(
          `UPDATE execution_runs SET state = 'interrupted', snapshot = ?, stop_reason = ?, updated_at = ? WHERE task_id = ?`,
          [JSON.stringify({ ...snapshot, state: "interrupted", stopReason: reason, updatedAt: now }), reason, now, row.task_id],
        )
      }
      getDb().run(
        `UPDATE task_runs SET status = 'interrupted', completed_at = ?,
         error = COALESCE(error, '应用退出或服务重启，任务执行被中断')
         WHERE status IN ('queued', 'running', 'cancelling', 'waiting-approval', 'waiting-delegation')`,
        [now],
      )
    }
    return unfinished.count
  },

  /**
   * An orphaned safety barrier is a quarantine, not a terminal task. A future
   * owner must prove that its ChangeSet was cleaned up
   * rolled back. Releasing it merely because the old coroutine disappeared
   * would allow another writer to cross unresolved workspace state.
   */
  recoverOrphanSafetyBarriers(): number {
    const rows = getDb().query(
      `SELECT child.id
       FROM task_runs child
       LEFT JOIN task_runs parent ON parent.id = child.parent_run_id
       WHERE child.status = 'safety-quarantine'
         AND child.parent_run_id IS NOT NULL
         AND (parent.id IS NULL OR parent.status NOT IN
           ('queued', 'running', 'cancelling', 'waiting-approval', 'waiting-delegation', 'safety-quarantine'))`,
    ).all() as Array<{ id: string }>
    if (rows.length === 0) return 0
    const now = Date.now()
    const reason = "父级主 Agent 运行已结束；未决工作区状态保持隔离，等待安全回滚"
    const updateTask = getDb().query(
      "UPDATE task_runs SET completed_at = NULL, error = ? WHERE id = ? AND status = 'safety-quarantine'",
    )
    const updateNode = getDb().query(
      "UPDATE run_graph_nodes SET status = 'safety-quarantine', updated_at = ? WHERE id = ?",
    )
    return getDb().transaction(() => {
      let changed = 0
      for (const row of rows) {
        changed += updateTask.run(reason, row.id).changes
        updateNode.run(now, row.id)
      }
      return changed
    })()
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM execution_runs WHERE session_id = ?", [sessionId])
    getDb().run("DELETE FROM task_runs WHERE session_id = ?", [sessionId])
  },
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
}

function toView(row: TaskRunRow): TaskRunView {
  return {
    id: row.id,
    parentRunId: row.parent_run_id ?? undefined,
    requestId: row.request_id ?? undefined,
    sessionId: row.session_id,
    agentId: row.agent_id,
    priority: row.priority,
    status: row.status,
    message: row.message,
    workingDir: row.working_dir,
    type: row.task_type,
    scope: row.scope ?? undefined,
    effort: row.effort ?? undefined,
    modelId: row.model_id ?? undefined,
    retryOf: row.retry_of ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  }
}
