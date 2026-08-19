import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { getDb } from "../store/database.ts"
import { ToolExecutionRepo } from "../store/tool-execution.ts"

export type ChangeSetStatus = "open" | "rolling-back" | "committed" | "rolled-back"

export interface WorkspaceRecoveryResult {
  rolledBack: number
  quarantined: number
}

/**
 * Workspace writes remain protected by scheduler resource leases until settlement.
 * Successful task settlement atomically advances the revision; failed work
 * reverses every
 * reversible execution in reverse order before releasing that lease.
 */
export const workspaceRevisionService = {
  open(runId: string, workspace: string): void {
    const root = resolve(workspace)
    const db = getDb()
    db.transaction(() => {
      const now = Date.now()
      db.run(
        "INSERT OR IGNORE INTO workspace_revisions (workspace, revision, updated_at) VALUES (?, 0, ?)",
        [root, now],
      )
      const revision = (db.query(
        "SELECT revision FROM workspace_revisions WHERE workspace = ?",
      ).get(root) as { revision: number }).revision
      db.run(
        `INSERT OR IGNORE INTO workspace_change_sets
         (id, run_id, workspace, base_revision, status, execution_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', '[]', ?, ?)`,
        [`changeset-${randomUUID()}`, runId, root, revision, now, now],
      )
    })()
  },

  prepare(runId: string, sessionId: string, accepted: boolean): number | null {
    const db = getDb()
    const changeSet = db.query(
      "SELECT * FROM workspace_change_sets WHERE run_id = ?",
    ).get(runId) as ChangeSetRow | null
    if (!changeSet) return null
    if (!accepted && changeSet.status === "rolling-back") {
      rollbackExecutions(runId, sessionId)
      return changeSet.base_revision
    }
    if (changeSet.status !== "open") throw new Error(`ChangeSet 已关闭: ${runId}`)
    const allExecutions = ToolExecutionRepo.listBySession(sessionId, 500)
      .filter((item) => item.runId === runId && item.status === "succeeded")
      .sort((left, right) => left.startedAt - right.startedAt)
    const unsafeStructuredWrite = allExecutions.find((item) =>
      ["write", "edit"].includes(item.toolName)
      && (!item.filePath || ((item.linesAdded > 0 || item.linesRemoved > 0) && !item.reversible)))
    if (unsafeStructuredWrite) {
      throw new Error(`ChangeSet 缺少可逆文件快照: ${unsafeStructuredWrite.toolName}`)
    }
    if (!accepted) {
      rollbackExecutions(runId, sessionId)
      return changeSet.base_revision
    }
    const current = db.query(
      "SELECT revision FROM workspace_revisions WHERE workspace = ?",
    ).get(changeSet.workspace) as { revision: number } | null
    if (!current || current.revision !== changeSet.base_revision) {
      throw new Error("Workspace Revision 冲突：任务基线已经过期")
    }
    return current.revision + 1
  },

  /**
   * Abort a delegated write attempt before releasing its resource lease. The intermediate
   * state makes rollback restartable: already-undone executions are skipped
   * after a process interruption.
   */
  rollback(runId: string, sessionId: string): void {
    const db = getDb()
    const current = db.query(
      "SELECT status FROM workspace_change_sets WHERE run_id = ?",
    ).get(runId) as { status: ChangeSetStatus } | null
    if (!current || current.status === "rolled-back") return
    if (current.status === "committed") throw new Error(`ChangeSet 已提交，不能回滚: ${runId}`)
    if (current.status === "open") {
      db.run(
        `UPDATE workspace_change_sets SET status = 'rolling-back', updated_at = ?
         WHERE run_id = ? AND status = 'open'`,
        [Date.now(), runId],
      )
    } else if (current.status !== "rolling-back") {
      throw new Error(`ChangeSet 状态不可回滚: ${current.status}`)
    }
    rollbackExecutions(runId, sessionId)
    if (db.run(
      `UPDATE workspace_change_sets SET status = 'rolled-back', updated_at = ?
       WHERE run_id = ? AND status = 'rolling-back'`,
      [Date.now(), runId],
    ).changes !== 1) {
      throw new Error(`ChangeSet 回滚状态提交冲突: ${runId}`)
    }
  },

  /**
   * Reconcile every unfinished ChangeSet before scheduler barriers are
   * restored. Unresolved changes remain quarantined for safe cleanup;
   * abandoned executions are rolled back. A failed rollback is converted to
   * a durable safety-quarantine barrier and therefore fails closed.
   */
  recoverUnsettled(): WorkspaceRecoveryResult {
    const db = getDb()
    const rows = db.query(
      `SELECT workspace_change_sets.run_id, workspace_change_sets.status,
              task_runs.session_id, task_runs.status AS task_status
       FROM workspace_change_sets
       JOIN task_runs ON task_runs.id = workspace_change_sets.run_id
       WHERE workspace_change_sets.status IN ('open', 'rolling-back')
       ORDER BY workspace_change_sets.created_at ASC`,
    ).all() as Array<{
      run_id: string
      status: ChangeSetStatus
      session_id: string
      task_status: string
    }>
    let rolledBack = 0
    let quarantined = 0
    for (const row of rows) {
      if (row.task_status === "safety-quarantine") {
        quarantineChangeSet(row.run_id, "应用恢复后继续保持工作区安全隔离，ChangeSet 资源屏障有效")
        quarantined++
        continue
      }
      try {
        this.rollback(row.run_id, row.session_id)
        rolledBack++
      } catch (error) {
        quarantineChangeSet(
          row.run_id,
          `应用恢复时 ChangeSet 自动回滚失败：${error instanceof Error ? error.message : String(error)}`,
        )
        quarantined++
      }
    }
    return { rolledBack, quarantined }
  },
}

function quarantineChangeSet(runId: string, reason: string): void {
  const db = getDb()
  const now = Date.now()
  db.transaction(() => {
    const changed = db.run(
      `UPDATE task_runs SET status = 'safety-quarantine', completed_at = NULL, error = ?
       WHERE id = ?`,
      [reason.slice(0, 4_000), runId],
    ).changes
    if (changed !== 1) throw new Error(`ChangeSet 对应任务不存在: ${runId}`)
    db.run(
      `UPDATE run_graph_nodes SET status = 'safety-quarantine', updated_at = ?
       WHERE id = ?`,
      [now, runId],
    )
  })()
}

function rollbackExecutions(runId: string, sessionId: string): void {
  const executions = ToolExecutionRepo.listBySession(sessionId, 500)
    .filter((item) => item.runId === runId && item.status === "succeeded" && item.filePath)
    .sort((left, right) => right.startedAt - left.startedAt)
  for (const execution of executions) {
    if (execution.undoneAt) continue
    if (!execution.reversible) {
      if (execution.linesAdded > 0 || execution.linesRemoved > 0) {
        throw new Error(`ChangeSet 包含不可回滚写操作: ${execution.toolName}`)
      }
      continue
    }
    ToolExecutionRepo.undo(execution.id)
  }
}

interface ChangeSetRow {
  id: string
  run_id: string
  workspace: string
  base_revision: number
  committed_revision: number | null
  status: ChangeSetStatus
  execution_ids: string
  created_at: number
  updated_at: number
}
