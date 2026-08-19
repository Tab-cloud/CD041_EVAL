import { getDb } from "./database.ts"

export type ApprovalRecordStatus = "pending" | "approved" | "denied" | "expired" | "cancelled"

export interface ApprovalRecordInput {
  id: string
  sessionId: string
  runId: string
  parentRunId?: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  reason: string
  target: string
  createdAt: number
  expiresAt: number
}

export const ToolApprovalRecordRepo = {
  create(value: ApprovalRecordInput): void {
    getDb().run(
      `INSERT OR REPLACE INTO tool_approvals
       (id, session_id, run_id, parent_run_id, tool_call_id, tool_name, tool_input,
        reason, target, status, created_at, expires_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      [value.id, value.sessionId, value.runId, value.parentRunId ?? null, value.toolCallId,
        value.toolName, JSON.stringify(value.input), value.reason, value.target, value.createdAt, value.expiresAt],
    )
  },

  settle(id: string, status: Exclude<ApprovalRecordStatus, "pending">): void {
    getDb().run(
      "UPDATE tool_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
      [status, Date.now(), id],
    )
  },

  recoverInterrupted(): number {
    const result = getDb().run(
      "UPDATE tool_approvals SET status = 'cancelled', resolved_at = ? WHERE status = 'pending'",
      [Date.now()],
    )
    return result.changes
  },
}
