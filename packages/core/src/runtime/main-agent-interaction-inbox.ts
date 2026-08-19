import { randomUUID } from "node:crypto"
import { getDb } from "../store/database"

export type SubAgentInteraction = {
  type: "approval-request" | "question-request"
  payload: unknown
  requiresMainAgentReview: true
  visibility: "internal"
}

export interface MainAgentInteractionView {
  id: string
  sourceId: string
  rootRunId: string
  childRunId: string
  sessionId: string
  kind: SubAgentInteraction["type"]
  payload: unknown
  state: "pending" | "escalated" | "resolved"
  createdAt: number
  resolvedAt?: number
}

interface InteractionRow {
  id: string
  source_id: string
  root_run_id: string
  child_run_id: string
  session_id: string
  kind: SubAgentInteraction["type"]
  payload: string
  state: MainAgentInteractionView["state"]
  created_at: number
  resolved_at: number | null
}

export const mainAgentInteractionInbox = {
  submit(input: {
    rootRunId: string
    sessionId: string
    request: SubAgentInteraction
  }): MainAgentInteractionView {
    const payload = objectPayload(input.request.payload)
    const sourceId = interactionSourceId(payload)
      || randomUUID()
    const childRunId = interactionRunId(payload) || input.rootRunId
    const existing = getDb().query(
      `SELECT * FROM main_agent_interactions
       WHERE root_run_id = ? AND source_id = ? AND kind = ?`,
    ).get(input.rootRunId, sourceId, input.request.type) as InteractionRow | null
    if (existing) return toView(existing)
    const id = randomUUID()
    const createdAt = Date.now()
    getDb().run(
      `INSERT INTO main_agent_interactions
       (id, source_id, root_run_id, child_run_id, session_id, kind, payload, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        id,
        sourceId,
        input.rootRunId,
        childRunId,
        input.sessionId,
        input.request.type,
        JSON.stringify(payload),
        createdAt,
      ],
    )
    return {
      id,
      sourceId,
      rootRunId: input.rootRunId,
      childRunId,
      sessionId: input.sessionId,
      kind: input.request.type,
      payload,
      state: "pending",
      createdAt,
    }
  },

  escalate(id: string): MainAgentInteractionView | null {
    getDb().run(
      `UPDATE main_agent_interactions SET state = 'escalated'
       WHERE id = ? AND state = 'pending'`,
      [id],
    )
    return this.get(id)
  },

  resolve(rootRunId: string, sourceId: string): void {
    getDb().run(
      `UPDATE main_agent_interactions
       SET state = 'resolved', resolved_at = ?
       WHERE root_run_id = ? AND source_id = ? AND state != 'resolved'`,
      [Date.now(), rootRunId, sourceId],
    )
  },

  get(id: string): MainAgentInteractionView | null {
    const row = getDb().query(
      "SELECT * FROM main_agent_interactions WHERE id = ?",
    ).get(id) as InteractionRow | null
    return row ? toView(row) : null
  },

  list(rootRunId: string): MainAgentInteractionView[] {
    const rows = getDb().query(
      `SELECT * FROM main_agent_interactions
       WHERE root_run_id = ? ORDER BY created_at ASC`,
    ).all(rootRunId) as InteractionRow[]
    return rows.map(toView)
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM main_agent_interactions WHERE session_id = ?", [sessionId])
  },
}

export function interactionPayload(value: unknown): Record<string, unknown> {
  const event = objectPayload(value)
  const nested = event.question ?? event.approval
  return nested && typeof nested === "object"
    ? nested as Record<string, unknown>
    : event
}

export function interactionSourceId(value: unknown): string {
  const payload = interactionPayload(value)
  return stringValue(payload.id)
    || stringValue(payload.questionId)
    || stringValue(payload.approvalId)
}

function interactionRunId(value: unknown): string {
  return stringValue(interactionPayload(value).runId)
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function toView(row: InteractionRow): MainAgentInteractionView {
  let payload: unknown = {}
  try { payload = JSON.parse(row.payload) } catch {}
  return {
    id: row.id,
    sourceId: row.source_id,
    rootRunId: row.root_run_id,
    childRunId: row.child_run_id,
    sessionId: row.session_id,
    kind: row.kind,
    payload,
    state: row.state,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  }
}
