import type { ExecutionSnapshot } from "../runtime/agent-loop-control.ts"
import { getDb } from "./database.ts"

interface ExecutionRunRow {
  task_id: string
  session_id: string
  parent_run_id: string | null
  run_type: ExecutionRunType
  state: ExecutionSnapshot["state"]
  snapshot: string
  stop_reason: string
  created_at: number
  updated_at: number
}

export interface ExecutionRunView {
  taskId: string
  sessionId: string
  parentRunId?: string
  runType: ExecutionRunType
  snapshot: ExecutionSnapshot
  createdAt: number
  updatedAt: number
}

export type ExecutionRunType = "root" | "subagent" | "workflow-node"

export interface ExecutionRunLineage {
  parentRunId?: string
  runType?: ExecutionRunType
}

export const ExecutionRunRepo = {
  initialize(taskId: string, sessionId: string, snapshot: ExecutionSnapshot, lineage: ExecutionRunLineage = {}): ExecutionRunView {
    const now = Date.now()
    getDb().run(
      `INSERT OR REPLACE INTO execution_runs
       (task_id, session_id, parent_run_id, run_type, state, snapshot, stop_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskId, sessionId, lineage.parentRunId ?? null, lineage.runType ?? "root",
        snapshot.state, JSON.stringify(snapshot), snapshot.stopReason ?? "", now, now],
    )
    return { taskId, sessionId, parentRunId: lineage.parentRunId, runType: lineage.runType ?? "root", snapshot, createdAt: now, updatedAt: now }
  },

  save(taskId: string, sessionId: string, snapshot: ExecutionSnapshot, lineage: ExecutionRunLineage = {}): void {
    const existing = this.get(taskId)
    if (!existing) {
      this.initialize(taskId, sessionId, snapshot, lineage)
      return
    }
    getDb().run(
      `UPDATE execution_runs SET state = ?, snapshot = ?, stop_reason = ?, updated_at = ? WHERE task_id = ?`,
      [snapshot.state, JSON.stringify(snapshot), snapshot.stopReason ?? "", Date.now(), taskId],
    )
  },

  get(taskId: string): ExecutionRunView | null {
    const row = getDb().query("SELECT * FROM execution_runs WHERE task_id = ?").get(taskId) as ExecutionRunRow | null
    return row ? toView(row) : null
  },

  latestBySession(sessionId: string): ExecutionRunView | null {
    const row = getDb().query(
      "SELECT * FROM execution_runs WHERE session_id = ? AND run_type = 'root' ORDER BY updated_at DESC, rowid DESC LIMIT 1",
    ).get(sessionId) as ExecutionRunRow | null
    return row ? toView(row) : null
  },

  latestResumableBySession(sessionId: string): ExecutionRunView | null {
    const row = getDb().query(
      `SELECT * FROM execution_runs
       WHERE session_id = ? AND run_type = 'root' AND state IN ('blocked', 'interrupted', 'failed', 'finalizing')
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId) as ExecutionRunRow | null
    return row ? toView(row) : null
  },

  latestRelevantBySession(sessionId: string): ExecutionRunView | null {
    // An actually active run is authoritative. Otherwise use the newest run;
    // an old interrupted objective must not permanently shadow a newer
    // completed turn in the Context panel.
    const active = getDb().query(
      `SELECT * FROM execution_runs WHERE session_id = ? AND run_type = 'root'
       AND state IN ('waiting-approval', 'running', 'finalizing')
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    ).get(sessionId) as ExecutionRunRow | null
    const row = active ?? getDb().query(
      "SELECT * FROM execution_runs WHERE session_id = ? AND run_type = 'root' ORDER BY updated_at DESC, rowid DESC LIMIT 1",
    ).get(sessionId) as ExecutionRunRow | null
    return row ? toView(row) : null
  },

  interruptUnfinished(reason = "应用退出或服务重启，任务执行被中断"): number {
    const rows = getDb().query(
      "SELECT * FROM execution_runs WHERE state IN ('running', 'waiting-approval', 'finalizing')",
    ).all() as ExecutionRunRow[]
    for (const row of rows) {
      const current = parseSnapshot(row.snapshot)
      const snapshot: ExecutionSnapshot = { ...current, state: "interrupted", stopReason: reason, updatedAt: Date.now() }
      this.save(row.task_id, row.session_id, snapshot)
    }
    return rows.length
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM execution_runs WHERE session_id = ?", [sessionId])
  },
}

function toView(row: ExecutionRunRow): ExecutionRunView {
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id ?? undefined,
    runType: row.run_type ?? "root",
    snapshot: parseSnapshot(row.snapshot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseSnapshot(value: string): ExecutionSnapshot {
  try { return JSON.parse(value) as ExecutionSnapshot } catch {
    return {
      state: "interrupted",
      todos: [],
      segment: 0,
      idleTurns: 0,
      toolRounds: 0,
      limit: 1,
      consecutiveNoProgress: 0,
      stopReason: "执行状态损坏，已安全中断",
      updatedAt: Date.now(),
    }
  }
}
