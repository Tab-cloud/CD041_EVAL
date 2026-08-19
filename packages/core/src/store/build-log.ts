import { getDb } from "./database"
import type { RunEventView } from "./run-event"

const MAX_LINES_PER_SESSION = 50_000

export const BuildLogRepo = {
  append(
    runId: string,
    sessionId: string,
    eventSeq: number,
    payload: { text: string; type: "stdout" | "stderr" | "info" },
    createdAt = Date.now(),
  ): void {
    getDb().transaction(() => {
      getDb().run(
        `INSERT OR REPLACE INTO build_log_lines
         (run_id, session_id, event_seq, stream_type, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [runId, sessionId, eventSeq, payload.type, payload.text.slice(0, 50_000), createdAt],
      )
      getDb().run(
        `DELETE FROM build_log_lines
         WHERE session_id = ? AND rowid NOT IN (
           SELECT rowid FROM build_log_lines
           WHERE session_id = ?
           ORDER BY created_at DESC, run_id DESC, event_seq DESC
           LIMIT ?
         )`,
        [sessionId, sessionId, MAX_LINES_PER_SESSION],
      )
    })()
  },

  listBySession(sessionId: string, limit = 5_000): RunEventView[] {
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 5_000, 50_000))
    const rows = getDb().query(
      `SELECT selected.*, COALESCE(events.projection_version, 0) AS projection_version
       FROM (
         SELECT * FROM build_log_lines
         WHERE session_id = ?
         ORDER BY created_at DESC, run_id DESC, event_seq DESC LIMIT ?
       ) AS selected
       LEFT JOIN run_events AS events
         ON events.run_id = selected.run_id AND events.seq = selected.event_seq
       ORDER BY selected.created_at ASC, selected.run_id ASC, selected.event_seq ASC`,
    ).all(sessionId, safeLimit) as Array<{
      run_id: string
      session_id: string
      event_seq: number
      stream_type: "stdout" | "stderr" | "info"
      text: string
      created_at: number
      projection_version: number
    }>
    return rows.map((row) => ({
      runId: row.run_id,
      sessionId: row.session_id,
      seq: row.event_seq,
      type: "tool-stream",
      payload: { target: "build", type: row.stream_type, text: row.text },
      projectionVersion: row.projection_version,
      createdAt: row.created_at,
    }))
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM build_log_lines WHERE session_id = ?", [sessionId])
  },

  deleteByRun(runId: string): void {
    getDb().run("DELETE FROM build_log_lines WHERE run_id = ?", [runId])
  },
}
