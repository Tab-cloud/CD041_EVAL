import { getDb } from "./database"

export interface StoredCallLog {
  id: string
  modelId: string
  modelName: string
  agentId: string
  sessionId: string
  prompt: string
  response: string
  tokens: { prompt: number; completion: number }
  latency: number
  success: boolean
  error?: string
  routeReason?: string
  routeAttempts?: Array<{
    modelId: string
    modelName: string
    attempt: number
    fallback: boolean
    reason: string
    previousError?: string
    attemptId?: string
    scope?: "agent" | "tool"
    segment?: number
    step?: number
  }>
  timestamp: number
}

interface CallLogRow {
  id: string; model_id: string; model_name: string; agent_id: string; session_id: string
  prompt_summary: string; response_summary: string; prompt_tokens: number; completion_tokens: number
  latency: number; success: number; error: string | null; route_reason: string | null
  route_attempts: string | null; timestamp: number
}

const MAX_LOGS = 1_000

export const CallLogRepo = {
  insert(log: StoredCallLog): void {
    getDb().run(
      `INSERT OR REPLACE INTO llm_call_logs
       (id, model_id, model_name, agent_id, session_id, prompt_summary, response_summary,
        prompt_tokens, completion_tokens, latency, success, error, route_reason, route_attempts, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.id, log.modelId, log.modelName, log.agentId, log.sessionId,
        log.prompt.slice(0, 500), log.response.slice(0, 500), log.tokens.prompt, log.tokens.completion,
        log.latency, Number(log.success), log.error?.slice(0, 2_000) ?? null,
        log.routeReason?.slice(0, 1_000) ?? null, JSON.stringify(log.routeAttempts ?? []).slice(0, 20_000), log.timestamp,
      ],
    )
    getDb().run(`DELETE FROM llm_call_logs WHERE id NOT IN (SELECT id FROM llm_call_logs ORDER BY timestamp DESC LIMIT ?)`, [MAX_LOGS])
  },

  list(filter?: { agentId?: string; modelId?: string; limit?: number }): StoredCallLog[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (filter?.agentId) { clauses.push("agent_id = ?"); values.push(filter.agentId) }
    if (filter?.modelId) { clauses.push("model_id = ?"); values.push(filter.modelId) }
    const limit = Math.min(MAX_LOGS, Math.max(1, filter?.limit ?? 50))
    values.push(limit)
    const rows = getDb().query(
      `SELECT * FROM llm_call_logs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY timestamp DESC LIMIT ?`,
    ).all(...values) as CallLogRow[]
    return rows.map(toView)
  },

  clear(): void { getDb().run("DELETE FROM llm_call_logs") },
  delete(id: string): void { getDb().run("DELETE FROM llm_call_logs WHERE id = ?", [id]) },
  count(): number { return (getDb().query("SELECT COUNT(*) AS count FROM llm_call_logs").get() as { count: number }).count },
}

function toView(row: CallLogRow): StoredCallLog {
  let routeAttempts: StoredCallLog["routeAttempts"] = []
  try { routeAttempts = JSON.parse(row.route_attempts ?? "[]") } catch {}
  return {
    id: row.id, modelId: row.model_id, modelName: row.model_name,
    agentId: row.agent_id, sessionId: row.session_id,
    prompt: row.prompt_summary, response: row.response_summary,
    tokens: { prompt: row.prompt_tokens, completion: row.completion_tokens },
    latency: row.latency, success: Boolean(row.success),
    error: row.error ?? undefined, routeReason: row.route_reason ?? undefined,
    routeAttempts, timestamp: row.timestamp,
  }
}
