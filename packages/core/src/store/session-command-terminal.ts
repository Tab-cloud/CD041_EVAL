import type { Database } from "bun:sqlite"

interface TerminalTaskProjection {
  id: string
  status: string
  error?: string
  completedAt?: number
}

/**
 * Project a durable root-task terminal into its public session command inside
 * the caller's transaction. This keeps task_runs, run_graphs and the command
 * queue on one commit boundary.
 */
export function syncSessionCommandTerminal(
  db: Database,
  task: TerminalTaskProjection,
): void {
  const commandState = task.status === "completed"
    ? "completed"
    : task.status === "cancelled"
      ? "cancelled"
      : task.status === "blocked"
      ? "blocked"
      : task.status === "failed" || task.status === "interrupted"
        ? "failed"
        : null
  if (!commandState) return
  db.run(
    `UPDATE session_commands
     SET state = ?, error = ?, completed_at = ?, owner_token = NULL
     WHERE task_id = ? AND state = 'accepted'`,
    [
      commandState,
      commandState === "completed"
        ? null
        : task.error?.slice(0, 4_000) ?? `根任务以 ${task.status} 结束`,
      task.completedAt ?? Date.now(),
      task.id,
    ],
  )
}
