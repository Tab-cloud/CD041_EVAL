import { getDb } from "./database.ts"
import type { TaskContract, TaskResult } from "../runtime/run-contract.ts"
import { aggregateRunGraphStatus, type RunNodeStatus } from "./run-graph.ts"

export interface RunContractView {
  runId: string
  sessionId: string
  parentRunId?: string
  agentId: string
  contract: TaskContract
  result?: TaskResult
  createdAt: number
  updatedAt: number
}

interface RunContractRow {
  run_id: string
  session_id: string
  parent_run_id: string | null
  agent_id: string
  contract: string
  result: string | null
  logical_task_id: string | null
  revision_of: string | null
  attempt: number
  created_at: number
  updated_at: number
}

export const RunContractRepo = {
  create(input: Omit<RunContractView, "result" | "createdAt" | "updatedAt">): RunContractView {
    const now = Date.now()
    getDb().run(
      `INSERT INTO run_contracts
       (run_id, session_id, parent_run_id, agent_id, contract, result,
        logical_task_id, revision_of, attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      [
        input.runId, input.sessionId, input.parentRunId ?? null, input.agentId,
        JSON.stringify(input.contract), input.contract.logicalTaskId ?? input.runId,
        input.contract.revisionOf ?? null, input.contract.attempt ?? 1, now, now,
      ],
    )
    return this.get(input.runId)!
  },

  complete(runId: string, result: TaskResult): RunContractView | null {
    getDb().run(
      "UPDATE run_contracts SET result = ?, updated_at = ? WHERE run_id = ?",
      [JSON.stringify(result), Date.now(), runId],
    )
    return this.get(runId)
  },

  /**
   * Atomically settle a successfully completed worker result.
   *
   * Result quality remains model-facing metadata; it is not converted into a
   * second score-based completion protocol. Workspace revision advancement is
   * committed in the same transaction as task and graph completion.
   */
  commitCompletedResult(
    runId: string,
    result: TaskResult,
    resultText: string,
    options?: { workflowNodeId?: string },
  ): boolean {
    const db = getDb()
    return db.transaction(() => {
      const contract = db.query(
        "SELECT result FROM run_contracts WHERE run_id = ?",
      ).get(runId) as { result: string | null } | null
      const task = db.query(
        "SELECT status FROM task_runs WHERE id = ?",
      ).get(runId) as { status: string } | null
      const node = db.query(
        "SELECT graph_id, status FROM run_graph_nodes WHERE id = ?",
      ).get(runId) as { graph_id: string; status: string } | null
      if (!contract || contract.result !== null || task?.status !== "running"
        || !node || node.status !== "running") return false

      const now = Date.now()
      if (db.run(
        "UPDATE run_contracts SET result = ?, updated_at = ? WHERE run_id = ? AND result IS NULL",
        [JSON.stringify(result), now, runId],
      ).changes !== 1) throw new Error("TaskResult 原子结算冲突")
      if (db.run(
        `UPDATE task_runs SET status = 'completed', result = ?, completed_at = ?, error = NULL
         WHERE id = ? AND status = 'running'`,
        [resultText.slice(0, 20_000), now, runId],
      ).changes !== 1) throw new Error("TaskRun 完成结算冲突")
      if (db.run(
        `UPDATE run_graph_nodes SET status = 'accepted', result_ref = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
        [`run-result:${runId}`, now, runId],
      ).changes !== 1) throw new Error("RunGraph 完成结算冲突")

      const workflowNode = options?.workflowNodeId
        ? db.query(
            "SELECT id, status, task_run_id FROM workflow_nodes WHERE id = ?",
          ).get(options.workflowNodeId) as { id: string; status: string; task_run_id: string | null } | null
        : db.query(
            "SELECT id, status, task_run_id FROM workflow_nodes WHERE task_run_id = ?",
          ).get(runId) as { id: string; status: string; task_run_id: string | null } | null
      if (options?.workflowNodeId && (!workflowNode || workflowNode.task_run_id !== runId)) {
        throw new Error("Workflow 节点与 TaskRun 绑定不一致")
      }
      if (workflowNode) {
        if (!['running', 'queued'].includes(workflowNode.status)) {
          throw new Error("Workflow 节点不在可结算状态")
        }
        if (db.run(
          `UPDATE workflow_nodes
           SET status = 'completed', result = ?, error = '', completed_at = ?, updated_at = ?
           WHERE id = ? AND task_run_id = ? AND status IN ('running', 'queued')`,
          [resultText.slice(0, 200_000), now, now, workflowNode.id, runId],
        ).changes !== 1) throw new Error("Workflow 完成结算冲突")
      }

      const changeSet = db.query(
        "SELECT workspace, base_revision, status FROM workspace_change_sets WHERE run_id = ?",
      ).get(runId) as { workspace: string; base_revision: number; status: string } | null
      if (changeSet) {
        if (changeSet.status !== "open") throw new Error("Workspace ChangeSet 已被关闭")
        const revision = db.query(
          "SELECT revision FROM workspace_revisions WHERE workspace = ?",
        ).get(changeSet.workspace) as { revision: number } | null
        if (!revision || revision.revision !== changeSet.base_revision) {
          throw new Error("Workspace Revision 完成结算冲突")
        }
        const next = revision.revision + 1
        if (db.run(
          "UPDATE workspace_revisions SET revision = ?, updated_at = ? WHERE workspace = ? AND revision = ?",
          [next, now, changeSet.workspace, changeSet.base_revision],
        ).changes !== 1) throw new Error("Workspace Revision 原子推进失败")
        if (db.run(
          `UPDATE workspace_change_sets SET status = 'committed', committed_revision = ?, updated_at = ?
           WHERE run_id = ? AND status = 'open'`,
          [next, now, runId],
        ).changes !== 1) throw new Error("Workspace ChangeSet 完成提交冲突")
      }

      const graphNodes = db.query(
        "SELECT kind, status FROM run_graph_nodes WHERE graph_id = ?",
      ).all(node.graph_id) as Array<{ kind: "root" | "delegated" | "workflow" | "review"; status: RunNodeStatus }>
      const aggregateStatus = aggregateRunGraphStatus(graphNodes)
      const graph = db.query(
        "SELECT version FROM run_graphs WHERE id = ?",
      ).get(node.graph_id) as { version: number } | null
      if (!graph) throw new Error("RunGraph 已丢失")
      const version = graph.version + 1
      db.run(
        "UPDATE run_graphs SET status = ?, version = ?, updated_at = ? WHERE id = ?",
        [aggregateStatus, version, now, node.graph_id],
      )
      db.run(
        `INSERT INTO run_graph_events
         (graph_id, graph_version, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
        [node.graph_id, version, "node-settled", JSON.stringify({ nodeId: runId, status: "accepted" }), now],
      )
      return true
    })()
  },

  get(runId: string): RunContractView | null {
    const row = getDb().query("SELECT * FROM run_contracts WHERE run_id = ?").get(runId) as RunContractRow | null
    return row ? toView(row) : null
  },

  listByParent(parentRunId: string): RunContractView[] {
    return (getDb().query(
      "SELECT * FROM run_contracts WHERE parent_run_id = ? ORDER BY created_at ASC",
    ).all(parentRunId) as RunContractRow[]).map(toView)
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM run_contracts WHERE session_id = ?", [sessionId])
  },
}

function toView(row: RunContractRow): RunContractView {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id ?? undefined,
    agentId: row.agent_id,
    contract: JSON.parse(row.contract) as TaskContract,
    result: row.result ? JSON.parse(row.result) as TaskResult : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
