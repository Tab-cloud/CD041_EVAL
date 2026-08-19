import { getDb } from "./database.ts"

export type ModelAttemptScope = "agent" | "tool"
export type ModelAttemptStatus = "running" | "succeeded" | "failed" | "cancelled" | "skipped"
export type ModelFailureKind = "fault-domain" | "quota" | "request" | "cancelled" | "circuit-open"

export interface ModelAttemptView {
  id: string
  runId: string
  sessionId: string
  agentId: string
  scope: ModelAttemptScope
  operation: string
  segment: number
  step: number
  attempt: number
  modelKey: string
  modelId: string
  modelName: string
  faultDomain: string
  status: ModelAttemptStatus
  failureKind?: ModelFailureKind
  error?: string
  startedAt: number
  completedAt?: number
  latency?: number
}

interface ModelAttemptRow {
  id: string
  run_id: string
  session_id: string
  agent_id: string
  scope: ModelAttemptScope
  operation: string
  segment: number
  step: number
  attempt: number
  model_key: string
  model_id: string
  model_name: string
  fault_domain: string
  status: ModelAttemptStatus
  failure_kind: ModelFailureKind | null
  error: string | null
  started_at: number
  completed_at: number | null
  latency: number | null
}

const MAX_ATTEMPTS = 5_000

export const ModelAttemptRepo = {
  start(input: Omit<ModelAttemptView, "status" | "startedAt" | "completedAt" | "latency">): ModelAttemptView {
    const startedAt = Date.now()
    getDb().run(
      `INSERT INTO model_attempts
       (id, run_id, session_id, agent_id, scope, operation, segment, step, attempt,
        model_key, model_id, model_name, fault_domain, status, failure_kind, error,
        started_at, completed_at, latency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL, NULL)`,
      [
        input.id, input.runId, input.sessionId, input.agentId, input.scope,
        input.operation, input.segment, input.step, input.attempt, input.modelKey,
        input.modelId, input.modelName, input.faultDomain, startedAt,
      ],
    )
    prune()
    return this.get(input.id)!
  },

  finish(
    id: string,
    status: Exclude<ModelAttemptStatus, "running">,
    failureKind?: ModelFailureKind,
    error?: string,
  ): ModelAttemptView | null {
    const completedAt = Date.now()
    getDb().run(
      `UPDATE model_attempts
       SET status = ?, failure_kind = ?, error = ?, completed_at = ?,
           latency = MAX(0, ? - started_at)
       WHERE id = ? AND status = 'running'`,
      [status, failureKind ?? null, error?.slice(0, 2_000) ?? null, completedAt, completedAt, id],
    )
    return this.get(id)
  },

  recordSkipped(input: Omit<ModelAttemptView, "status" | "startedAt" | "completedAt" | "latency"> & {
    error: string
  }): ModelAttemptView {
    const now = Date.now()
    getDb().run(
      `INSERT INTO model_attempts
       (id, run_id, session_id, agent_id, scope, operation, segment, step, attempt,
        model_key, model_id, model_name, fault_domain, status, failure_kind, error,
        started_at, completed_at, latency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'skipped', 'circuit-open', ?, ?, ?, 0)`,
      [
        input.id, input.runId, input.sessionId, input.agentId, input.scope,
        input.operation, input.segment, input.step, input.attempt, input.modelKey,
        input.modelId, input.modelName, input.faultDomain, input.error.slice(0, 2_000),
        now, now,
      ],
    )
    prune()
    return this.get(input.id)!
  },

  get(id: string): ModelAttemptView | null {
    const row = getDb().query("SELECT * FROM model_attempts WHERE id = ?").get(id) as ModelAttemptRow | null
    return row ? mapAttempt(row) : null
  },

  recentByFaultDomain(faultDomain: string, since: number, limit = 50): ModelAttemptView[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    return (getDb().query(
      `SELECT * FROM model_attempts
       WHERE fault_domain = ? AND completed_at >= ? AND status IN ('succeeded', 'failed')
       ORDER BY completed_at DESC LIMIT ?`,
    ).all(faultDomain, since, safeLimit) as ModelAttemptRow[]).map(mapAttempt)
  },

  recentByModel(modelKey: string, since: number, limit = 50): ModelAttemptView[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    return (getDb().query(
      `SELECT * FROM model_attempts
       WHERE model_key = ? AND completed_at >= ? AND status IN ('succeeded', 'failed')
       ORDER BY completed_at DESC LIMIT ?`,
    ).all(modelKey, since, safeLimit) as ModelAttemptRow[]).map(mapAttempt)
  },

  listByRun(runId: string, limit = 200): ModelAttemptView[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)))
    return (getDb().query(
      "SELECT * FROM model_attempts WHERE run_id = ? ORDER BY started_at ASC LIMIT ?",
    ).all(runId, safeLimit) as ModelAttemptRow[]).map(mapAttempt)
  },

  listRecent(limit = 200): ModelAttemptView[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)))
    return (getDb().query(
      "SELECT * FROM model_attempts ORDER BY started_at DESC LIMIT ?",
    ).all(safeLimit) as ModelAttemptRow[]).map(mapAttempt)
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM model_attempts WHERE session_id = ?", [sessionId])
  },

  recoverInterrupted(): number {
    const now = Date.now()
    return getDb().run(
      `UPDATE model_attempts
       SET status = 'cancelled', failure_kind = 'cancelled',
           error = '应用退出或服务重启，模型调用被中断',
           completed_at = ?, latency = MAX(0, ? - started_at)
       WHERE status = 'running'`,
      [now, now],
    ).changes
  },
}

function prune(): void {
  getDb().run(
    `DELETE FROM model_attempts
     WHERE id NOT IN (SELECT id FROM model_attempts ORDER BY started_at DESC LIMIT ?)`,
    [MAX_ATTEMPTS],
  )
}

function mapAttempt(row: ModelAttemptRow): ModelAttemptView {
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    scope: row.scope,
    operation: row.operation,
    segment: row.segment,
    step: row.step,
    attempt: row.attempt,
    modelKey: row.model_key,
    modelId: row.model_id,
    modelName: row.model_name,
    faultDomain: row.fault_domain,
    status: row.status,
    failureKind: row.failure_kind ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    latency: row.latency ?? undefined,
  }
}
