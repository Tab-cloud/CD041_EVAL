import { randomUUID } from "node:crypto"
import { getDb } from "./database.ts"
import { stringifyBoundedJson } from "./bounded-json.ts"

export type OrchestrationLogLevel = "debug" | "info" | "warning" | "error"

export interface OrchestrationLogView {
  sequence: number
  id: string
  sessionId: string
  runId: string
  parentRunId?: string
  agentId?: string
  eventType: string
  level: OrchestrationLogLevel
  message: string
  data: Record<string, unknown>
  createdAt: number
}

interface OrchestrationLogRow {
  sequence: number
  id: string; session_id: string; run_id: string; parent_run_id: string | null
  agent_id: string | null; event_type: string; level: OrchestrationLogLevel
  message: string; data: string; created_at: number
}

const MAX_LOGS = 20_000
const PRUNE_INTERVAL = 250
let writesSincePrune = 0

export const OrchestrationLogRepo = {
  insert(input: Omit<OrchestrationLogView, "sequence" | "id" | "createdAt"> & { id?: string; createdAt?: number }): OrchestrationLogView {
    const entry = {
      id: input.id ?? `orch-${randomUUID()}`,
      sessionId: input.sessionId,
      runId: input.runId,
      parentRunId: input.parentRunId,
      agentId: input.agentId,
      eventType: input.eventType,
      level: input.level,
      message: input.message.slice(0, 2_000),
      data: input.data,
      createdAt: input.createdAt ?? Date.now(),
    }
    const inserted = getDb().run(
      `INSERT INTO agent_orchestration_logs
       (id, session_id, run_id, parent_run_id, agent_id, event_type, level, message, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.sessionId, entry.runId, entry.parentRunId ?? null, entry.agentId ?? null,
        entry.eventType, entry.level, entry.message, stringifyBoundedJson(entry.data, 20_000), entry.createdAt],
    )
    writesSincePrune++
    if (writesSincePrune >= PRUNE_INTERVAL) {
      writesSincePrune = 0
      getDb().run(
        `DELETE FROM agent_orchestration_logs
         WHERE rowid <= COALESCE((
           SELECT rowid FROM agent_orchestration_logs
           ORDER BY rowid DESC LIMIT 1 OFFSET ?
         ), 0)`,
        [MAX_LOGS],
      )
    }
    const sequence = Number(inserted.lastInsertRowid)
    return { ...entry, sequence }
  },

  list(filter: { sessionId?: string; runId?: string; parentRunId?: string; eventType?: string; limit?: number } = {}): OrchestrationLogView[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (filter.sessionId) { clauses.push("session_id = ?"); values.push(filter.sessionId) }
    if (filter.runId) { clauses.push("run_id = ?"); values.push(filter.runId) }
    if (filter.parentRunId) { clauses.push("parent_run_id = ?"); values.push(filter.parentRunId) }
    if (filter.eventType) { clauses.push("event_type = ?"); values.push(filter.eventType) }
    values.push(Math.max(1, Math.min(filter.limit ?? 200, 2_000)))
    const rows = getDb().query(
      `SELECT rowid AS sequence, * FROM agent_orchestration_logs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY rowid DESC LIMIT ?`,
    ).all(...values) as OrchestrationLogRow[]
    return rows.map(toView)
  },

  clear(): void { getDb().run("DELETE FROM agent_orchestration_logs") },
}

function toView(row: OrchestrationLogRow): OrchestrationLogView {
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(row.data) as Record<string, unknown> } catch {}
  return {
    sequence: row.sequence, id: row.id, sessionId: row.session_id, runId: row.run_id,
    parentRunId: row.parent_run_id ?? undefined, agentId: row.agent_id ?? undefined,
    eventType: row.event_type, level: row.level, message: row.message,
    data, createdAt: row.created_at,
  }
}
