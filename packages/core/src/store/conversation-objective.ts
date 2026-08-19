import { randomUUID } from "node:crypto"
import type { ConversationObjectiveProposal } from "../runtime/conversation-objective.ts"
import { getDb } from "./database.ts"

export type ConversationObjectiveState = "proposed" | "active" | "completed" | "superseded"

interface ConversationObjectiveRow {
  id: string
  session_id: string
  source_message_id: string
  content: string
  task_count: number
  state: ConversationObjectiveState
  active_run_id: string | null
  created_at: number
  updated_at: number
}

export interface ConversationObjectiveView extends ConversationObjectiveProposal {
  id: string
  sessionId: string
  sourceMessageId: string
  state: ConversationObjectiveState
  activeRunId?: string
  createdAt: number
  updatedAt: number
}

export const ConversationObjectiveRepo = {
  propose(sessionId: string, proposal: ConversationObjectiveProposal): ConversationObjectiveView | null {
    if (!proposal.sourceMessageId || proposal.taskCount < 1 || !proposal.content.trim()) return null
    const existing = this.getBySource(sessionId, proposal.sourceMessageId)
    if (existing) {
      if (existing.state !== "completed"
        && (existing.content !== proposal.content || existing.taskCount !== proposal.taskCount)) {
        getDb().run(
          `UPDATE conversation_objectives
           SET content = ?, task_count = ?, updated_at = ?
           WHERE id = ? AND state IN ('proposed', 'active')`,
          [proposal.content, proposal.taskCount, Date.now(), existing.id],
        )
        return this.get(existing.id)
      }
      return existing
    }
    const id = `objective-${randomUUID()}`
    const now = Date.now()
    getDb().run(
      `INSERT INTO conversation_objectives
       (id, session_id, source_message_id, content, task_count, state, active_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', NULL, ?, ?)`,
      [id, sessionId, proposal.sourceMessageId, proposal.content, proposal.taskCount, now, now],
    )
    return this.get(id)
  },

  get(id: string): ConversationObjectiveView | null {
    const row = getDb().query("SELECT * FROM conversation_objectives WHERE id = ?")
      .get(id) as ConversationObjectiveRow | null
    return row ? toView(row) : null
  },

  getBySource(sessionId: string, sourceMessageId: string): ConversationObjectiveView | null {
    const row = getDb().query(
      "SELECT * FROM conversation_objectives WHERE session_id = ? AND source_message_id = ?",
    ).get(sessionId, sourceMessageId) as ConversationObjectiveRow | null
    return row ? toView(row) : null
  },

  openBySession(sessionId: string): ConversationObjectiveView[] {
    const rows = getDb().query(
      `SELECT * FROM conversation_objectives
       WHERE session_id = ? AND state IN ('proposed', 'active')
       ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC`,
    ).all(sessionId) as ConversationObjectiveRow[]
    return rows.map(toView)
  },

  activate(sessionId: string, sourceMessageId: string, runId: string): ConversationObjectiveView | null {
    const current = this.getBySource(sessionId, sourceMessageId)
    if (!current) return null
    getDb().run(
      `UPDATE conversation_objectives
       SET state = 'active', active_run_id = ?, updated_at = ?
       WHERE id = ? AND state IN ('proposed', 'active')`,
      [runId, Date.now(), current.id],
    )
    return this.get(current.id)
  },

  complete(id: string, runId: string): boolean {
    const result = getDb().run(
      `UPDATE conversation_objectives
       SET state = 'completed', active_run_id = ?, updated_at = ?
       WHERE id = ? AND state = 'active' AND active_run_id = ?`,
      [runId, Date.now(), id, runId],
    )
    return result.changes > 0
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM conversation_objectives WHERE session_id = ?", [sessionId])
  },
}

function toView(row: ConversationObjectiveRow): ConversationObjectiveView {
  const tasks = [...row.content.matchAll(/(?:^|\n)\s*\d{1,2}[.)、]\s+([^\n]+)/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean)
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceMessageId: row.source_message_id,
    content: row.content,
    taskCount: row.task_count,
    tasks: tasks.length > 0 ? tasks : [row.content],
    state: row.state,
    activeRunId: row.active_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
