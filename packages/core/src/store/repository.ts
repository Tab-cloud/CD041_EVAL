/**
 * Repository — Session / Message / Project CRUD
 */

import { getDb } from "./database"
import { randomUUID } from "node:crypto"

// ══════════════════════════════════════════════
// Session
// ══════════════════════════════════════════════

export interface SessionRow {
  id: string; title: string; agent_id: string
  main_agent_instance_id: string
  project_path: string | null; created_at: number; updated_at: number
  archived: number; summary: string | null
  compact_summary: string | null   // JSON: {content, timestamp}
  compact_at: number | null        // 压缩时间戳（冗余，便于排序/查询）
  composer_model_id: string | null
  composer_effort: "on" | "off"
  composer_scope: "confirm-changes" | "auto-edit" | "plan-mode" | "full-access"
}

export interface MessageRow {
  id: string; session_id: string; request_id: string | null; role: string; content: string
  agent_id: string | null; tool_calls: string | null; tool_results: string | null
  seq: number; timestamp: number
}

export const SessionRepo = {
  create(s: Omit<SessionRow,
    "main_agent_instance_id" | "created_at" | "updated_at" | "archived" | "summary"
    | "compact_summary" | "compact_at" | "composer_model_id" | "composer_effort" | "composer_scope"
  > & Partial<Pick<SessionRow, "composer_model_id" | "composer_effort" | "composer_scope">>): SessionRow {
    const now = Date.now()
    const mainAgentInstanceId = `main-${s.id}`
    const composerModelId = s.composer_model_id?.trim() || null
    const composerEffort = s.composer_effort ?? "on"
    const composerScope = s.composer_scope ?? "auto-edit"
    getDb().run(
      `INSERT INTO sessions
        (id, title, agent_id, main_agent_instance_id, project_path, composer_model_id,
         composer_effort, composer_scope, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        s.id, s.title, s.agent_id, mainAgentInstanceId, s.project_path, composerModelId,
        composerEffort, composerScope, now, now,
      ],
    )
    return {
      ...s, main_agent_instance_id: mainAgentInstanceId,
      archived: 0, summary: null, compact_summary: null, compact_at: null,
      composer_model_id: composerModelId, composer_effort: composerEffort, composer_scope: composerScope,
      created_at: now, updated_at: now,
    }
  },

  get(id: string): SessionRow | null {
    return getDb().query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null
  },

  list(): SessionRow[] {
    return getDb().query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[]
  },

  update(id: string, fields: Partial<Pick<SessionRow, "title" | "agent_id" | "project_path">>) {
    const sets: string[] = []; const vals: any[] = []
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`); vals.push(v)
    }
    sets.push("updated_at = ?"); vals.push(Date.now()); vals.push(id)
    getDb().run(`UPDATE sessions SET ${sets.join(",")} WHERE id = ?`, vals)
  },

  updateComposerPreferences(id: string, fields: Partial<Pick<
    SessionRow, "composer_model_id" | "composer_effort" | "composer_scope"
  >>): SessionRow | null {
    const sets: string[] = []
    const values: any[] = []
    if ("composer_model_id" in fields) {
      sets.push("composer_model_id = ?")
      values.push(fields.composer_model_id?.trim() || null)
    }
    if (fields.composer_effort) {
      sets.push("composer_effort = ?")
      values.push(fields.composer_effort)
    }
    if (fields.composer_scope) {
      sets.push("composer_scope = ?")
      values.push(fields.composer_scope)
    }
    if (sets.length === 0) {
      return getDb().query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null
    }
    sets.push("updated_at = ?")
    values.push(Date.now(), id)
    getDb().run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, values)
    return getDb().query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null
  },

  delete(id: string) {
    // Session ownership is the aggregate boundary. Remove every non-FK fact
    // in the same transaction so reviews, logs or queued work cannot become
    // orphaned after the conversation is deleted.
    const db = getDb()
    db.transaction(() => {
      db.run(
        "DELETE FROM workspace_change_sets WHERE run_id IN (SELECT run_id FROM run_contracts WHERE session_id = ?)",
        [id],
      )
      for (const table of [
        "conversation_objectives",
        "session_artifacts",
        "session_artifact_state",
        "main_agent_interactions",
        "run_guidance",
        "session_commands",
        "run_graphs",
        "run_contracts",
        "agent_orchestration_logs",
        "build_log_lines",
        "run_events",
        "tool_approvals",
        "execution_runs",
        "llm_call_logs",
        "tool_executions",
        "task_runs",
      ]) {
        db.run(`DELETE FROM ${table} WHERE session_id = ?`, [id])
      }
      db.run("DELETE FROM messages WHERE session_id = ?", [id])
      db.run("DELETE FROM sessions WHERE id = ?", [id])
    })()
  },

  archive(id: string, summary: string) {
    getDb().run("UPDATE sessions SET archived = 1, summary = ?, updated_at = ? WHERE id = ?", [summary, Date.now(), id])
  },

  // 取消归档：恢复为活跃会话，清除摘要（消息仍保留在 messages 表中）
  unarchive(id: string) {
    getDb().run("UPDATE sessions SET archived = 0, summary = NULL, updated_at = ? WHERE id = ?", [Date.now(), id])
  },

  // ── 上下文压缩 ──
  // 持久化结构化压缩摘要到 sessions 表（权威来源，不依赖 localStorage）
  setCompact(id: string, content: string, metadata: {
    throughSeq?: number
    mode?: "manual" | "auto" | "fallback"
    originalTokens?: number
    compactedTokens?: number
  } = {}) {
    const ts = Date.now()
    const compactSummary = { content, timestamp: ts, ...metadata }
    const payload = JSON.stringify(compactSummary)
    getDb().run(
      "UPDATE sessions SET compact_summary = ?, compact_at = ?, updated_at = ? WHERE id = ?",
      [payload, ts, ts, id],
    )
    return compactSummary
  },

  clearCompact(id: string) {
    getDb().run(
      "UPDATE sessions SET compact_summary = NULL, compact_at = NULL, updated_at = ? WHERE id = ?",
      [Date.now(), id],
    )
  },

  searchSummaries(query: string): Array<{ id: string; title: string; summary: string }> {
    return getDb().query(
      "SELECT id, title, summary FROM sessions WHERE archived = 1 AND summary LIKE ? ORDER BY updated_at DESC LIMIT 10"
    ).all(`%${query}%`) as any[]
  },
}

// ══════════════════════════════════════════════
// Message
// ══════════════════════════════════════════════

export const MessageRepo = {
  create(m: Omit<MessageRow, "id">): MessageRow {
    const id = `msg-${randomUUID()}`
    const db = getDb()
    // A request-bound conversation turn is immutable. Retried dispatcher
    // execution returns the already-persisted role message instead of
    // allocating a new seq and duplicating the visible turn.
    let seq = m.seq
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        db.run(
          `INSERT INTO messages
           (id, session_id, request_id, role, content, agent_id, tool_calls, tool_results, seq, timestamp)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            id, m.session_id, m.request_id, m.role, m.content, m.agent_id,
            m.tool_calls, m.tool_results, seq, m.timestamp,
          ],
        )
        // 更新 session 时间
        db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [Date.now(), m.session_id])
        return { ...m, id, seq }
      } catch (err: any) {
        if (String(err.message).includes("UNIQUE")) {
          if (m.request_id) {
            const existing = db.query(
              `SELECT * FROM messages
               WHERE session_id = ? AND request_id = ? AND role = ?`,
            ).get(m.session_id, m.request_id, m.role) as MessageRow | null
            if (existing) return existing
          }
          if (attempt >= 2) throw err
          // A different turn won the seq race; allocate the next position.
          const r = db.query("SELECT COALESCE(MAX(seq), 0) as v FROM messages WHERE session_id = ?").get(m.session_id) as { v: number }
          seq = r.v + 1
          continue
        }
        throw err
      }
    }
    return { ...m, id, seq }
  },

  getBySession(sessionId: string): MessageRow[] {
    return getDb().query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC").all(sessionId) as MessageRow[]
  },

  getBySessionAfter(sessionId: string, afterSeq: number): MessageRow[] {
    return getDb().query("SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC").all(sessionId, afterSeq) as MessageRow[]
  },

  latestSeq(sessionId: string): number {
    const r = getDb().query("SELECT COALESCE(MAX(seq), 0) as v FROM messages WHERE session_id = ?").get(sessionId) as { v: number }
    return r.v
  },

  deleteBySession(sessionId: string) {
    getDb().run("DELETE FROM messages WHERE session_id = ?", [sessionId])
  },
}

// ══════════════════════════════════════════════
// Project
// ══════════════════════════════════════════════

export interface ProjectRow {
  id: string; name: string; path: string
  chip: string | null; chip_family: string | null
  config: string | null; created_at: number
}

export const ProjectRepo = {
  create(p: Omit<ProjectRow, "id" | "created_at">): ProjectRow {
    const id = `proj-${randomUUID()}`
    const now = Date.now()
    getDb().run(
      "INSERT INTO projects (id, name, path, chip, chip_family, config, created_at) VALUES (?,?,?,?,?,?,?)",
      [id, p.name, p.path, p.chip, p.chip_family, p.config, now],
    )
    return { ...p, id, created_at: now }
  },

  getByPath(path: string): ProjectRow | null {
    return getDb().query("SELECT * FROM projects WHERE path = ?").get(path) as ProjectRow | null
  },

  list(): ProjectRow[] {
    return getDb().query("SELECT * FROM projects ORDER BY created_at DESC").all() as ProjectRow[]
  },

  update(path: string, fields: Partial<Omit<ProjectRow, "id" | "path" | "created_at">>) {
    const sets: string[] = []; const vals: any[] = []
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v) }
    vals.push(path)
    getDb().run(`UPDATE projects SET ${sets.join(",")} WHERE path = ?`, vals)
  },

  delete(path: string) {
    getDb().run("DELETE FROM projects WHERE path = ?", [path])
  },
}

// ══════════════════════════════════════════════
// Config KV
// ══════════════════════════════════════════════

export const ConfigRepo = {
  get(key: string): string | null {
    const r = getDb().query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null
    return r?.value ?? null
  },

  set(key: string, value: string) {
    getDb().run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, value])
  },

  delete(key: string) {
    getDb().run("DELETE FROM config WHERE key = ?", [key])
  },

  all(): Record<string, string> {
    const rows = getDb().query("SELECT * FROM config").all() as Array<{ key: string; value: string }>
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  },
}
