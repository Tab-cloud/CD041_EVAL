import { getDb } from "./database.ts"
import type { RuntimeEventType } from "../runtime/runtime-protocol.ts"
import { stringifyBoundedJson } from "./bounded-json.ts"

export interface RunEventView {
  runId: string
  sessionId: string
  seq: number
  type: RuntimeEventType
  payload: unknown
  projectionVersion: number
  createdAt: number
}

const MAX_EVENTS_PER_RUN = 2_000
const MAX_REPLAY_BUILD_LINES_PER_RUN = 1_000
export const PUBLIC_AGENT_LOG_EVENT_TYPES: RuntimeEventType[] = [
  "task-status",
  "serial-context",
  "context-compaction",
  "tool-call",
  "tool-result",
  "model-routed",
  "model-attempt",
  "execution-phase",
  "error",
]

export function isPublicAgentLogEvent(type: RuntimeEventType): boolean {
  return PUBLIC_AGENT_LOG_EVENT_TYPES.includes(type)
}

export const RunEventRepo = {
  append(
    runId: string,
    sessionId: string,
    type: RuntimeEventType,
    payload: unknown,
    projectionVersion = 0,
  ): RunEventView {
    const createdAt = Date.now()
    const db = getDb()
    return db.transaction(() => {
      const row = db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?")
        .get(runId) as { seq: number }
      const seq = row.seq + 1
      const serialized = stringifyBoundedJson(payload, 200_000)
      db.run(
        `INSERT INTO run_events
         (run_id, session_id, seq, event_type, payload, projection_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [runId, sessionId, seq, type, serialized, projectionVersion, createdAt],
      )
      db.run(
        `DELETE FROM run_events
         WHERE run_id = ?
           AND NOT (event_type = 'tool-stream' AND json_extract(payload, '$.target') = 'build')
           AND seq NOT IN (
             SELECT seq FROM run_events
             WHERE run_id = ?
               AND NOT (event_type = 'tool-stream' AND json_extract(payload, '$.target') = 'build')
             ORDER BY seq DESC LIMIT ?
           )`,
        [runId, runId, MAX_EVENTS_PER_RUN],
      )
      db.run(
        `DELETE FROM run_events
         WHERE run_id = ?
           AND event_type = 'tool-stream'
           AND json_extract(payload, '$.target') = 'build'
           AND seq NOT IN (
             SELECT seq FROM run_events
             WHERE run_id = ?
               AND event_type = 'tool-stream'
               AND json_extract(payload, '$.target') = 'build'
             ORDER BY seq DESC LIMIT ?
           )`,
        [runId, runId, MAX_REPLAY_BUILD_LINES_PER_RUN],
      )
      return { runId, sessionId, seq, type, payload, projectionVersion, createdAt }
    }).immediate()
  },

  listAfter(runId: string, after = 0, limit = 500): RunEventView[] {
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 500, 1_000))
    const rows = getDb().query(
      "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    ).all(runId, Math.max(0, after), safeLimit) as Array<{
      run_id: string; session_id: string; seq: number; event_type: RuntimeEventType
      payload: string; projection_version: number; created_at: number
    }>
    return rows.map((row) => ({
      runId: row.run_id, sessionId: row.session_id, seq: row.seq, type: row.event_type,
      payload: parsePayload(row.payload), projectionVersion: row.projection_version,
      createdAt: row.created_at,
    }))
  },

  listPublicLogsBySession(sessionId: string, limit = 500): RunEventView[] {
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 500, 1_000))
    const placeholders = PUBLIC_AGENT_LOG_EVENT_TYPES.map(() => "?").join(",")
    const rows = getDb().query(
      `SELECT * FROM (
         SELECT * FROM run_events
         WHERE session_id = ? AND event_type IN (${placeholders})
         ORDER BY created_at DESC, run_id DESC, seq DESC LIMIT ?
       ) ORDER BY created_at ASC, run_id ASC, seq ASC`,
    ).all(sessionId, ...PUBLIC_AGENT_LOG_EVENT_TYPES, safeLimit) as Array<{
      run_id: string; session_id: string; seq: number; event_type: RuntimeEventType
      payload: string; projection_version: number; created_at: number
    }>
    return rows.map((row) => ({
      runId: row.run_id, sessionId: row.session_id, seq: row.seq, type: row.event_type,
      payload: parsePayload(row.payload), projectionVersion: row.projection_version,
      createdAt: row.created_at,
    }))
  },

  listBuildLogsBySession(sessionId: string, limit = 2_000): RunEventView[] {
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 2_000, 2_000))
    const rows = getDb().query(
      `SELECT * FROM (
         SELECT * FROM run_events
         WHERE session_id = ? AND event_type = 'tool-stream'
           AND json_extract(payload, '$.target') = 'build'
         ORDER BY created_at DESC, run_id DESC, seq DESC LIMIT ?
       ) ORDER BY created_at ASC, run_id ASC, seq ASC`,
    ).all(sessionId, safeLimit) as Array<{
      run_id: string; session_id: string; seq: number; event_type: RuntimeEventType
      payload: string; projection_version: number; created_at: number
    }>
    return rows.map((row) => ({
      runId: row.run_id, sessionId: row.session_id, seq: row.seq, type: row.event_type,
      payload: parsePayload(row.payload), projectionVersion: row.projection_version,
      createdAt: row.created_at,
    }))
  },

  deletePublicLogsBySession(sessionId: string): void {
    const placeholders = PUBLIC_AGENT_LOG_EVENT_TYPES.map(() => "?").join(",")
    getDb().run(
      `DELETE FROM run_events WHERE session_id = ? AND event_type IN (${placeholders})`,
      [sessionId, ...PUBLIC_AGENT_LOG_EVENT_TYPES],
    )
  },

  deleteBuildLogsBySession(sessionId: string): void {
    getDb().run(
      `DELETE FROM run_events
       WHERE session_id = ? AND event_type = 'tool-stream'
         AND json_extract(payload, '$.target') = 'build'`,
      [sessionId],
    )
  },

  deleteByRun(runId: string): void {
    getDb().run("DELETE FROM run_events WHERE run_id = ?", [runId])
  },
}

function parsePayload(value: string): unknown {
  try { return JSON.parse(value) } catch { return { error: "事件载荷损坏" } }
}
