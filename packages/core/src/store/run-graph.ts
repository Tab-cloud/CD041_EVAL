import { getDb } from "./database.ts"
import type { TaskRunView } from "./task-run.ts"
import { syncSessionCommandTerminal } from "./session-command-terminal.ts"

export type RunGraphStatus = "planned" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted"
export type RunNodeKind = "root" | "delegated" | "workflow" | "review"
export type RunNodeStatus =
  | "queued" | "running" | "waiting-approval" | "waiting-delegation"
  | "safety-quarantine" | "blocked"
  | "accepted" | "failed" | "cancelled" | "interrupted"
export type RunEdgeType = "depends-on" | "revises" | "reviews" | "blocks"

export interface RunGraphView {
  id: string
  sessionId: string
  objective: string
  ownerInstanceId: string
  status: RunGraphStatus
  version: number
  createdAt: number
  updatedAt: number
  nodes: RunNodeView[]
  edges: RunEdgeView[]
}

export interface RunNodeView {
  id: string
  graphId: string
  parentNodeId?: string
  logicalTaskId: string
  attempt: number
  kind: RunNodeKind
  agentId: string
  status: RunNodeStatus
  contractRef?: string
  resultRef?: string
  createdAt: number
  updatedAt: number
}

export interface RunEdgeView {
  graphId: string
  fromNodeId: string
  toNodeId: string
  type: RunEdgeType
  createdAt: number
}

export interface RunGraphEventView {
  graphId: string
  version: number
  type: string
  payload: Record<string, unknown>
  createdAt: number
}

interface GraphRow {
  id: string; session_id: string; objective: string; owner_instance_id: string
  status: RunGraphStatus; version: number; created_at: number; updated_at: number
}
interface NodeRow {
  id: string; graph_id: string; parent_node_id: string | null; logical_task_id: string
  attempt: number; kind: RunNodeKind; agent_id: string; status: RunNodeStatus
  contract_ref: string | null; result_ref: string | null; created_at: number; updated_at: number
}
interface EdgeRow {
  graph_id: string; from_node_id: string; to_node_id: string; edge_type: RunEdgeType; created_at: number
}
interface EventRow {
  graph_id: string; graph_version: number; event_type: string; payload: string; created_at: number
}

export const RunGraphRepo = {
  create(input: {
    id: string; sessionId: string; objective: string; ownerInstanceId: string; status?: RunGraphStatus
  }): RunGraphView {
    const now = Date.now()
    getDb().run(
      `INSERT OR IGNORE INTO run_graphs
       (id, session_id, objective, owner_instance_id, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [input.id, input.sessionId, input.objective, input.ownerInstanceId, input.status ?? "planned", now, now],
    )
    return this.get(input.id)!
  },

  get(id: string): RunGraphView | null {
    const row = getDb().query("SELECT * FROM run_graphs WHERE id = ?").get(id) as GraphRow | null
    return row ? mapGraph(row, this.listNodes(id), this.listEdges(id)) : null
  },

  latestBySession(sessionId: string): RunGraphView | null {
    const row = getDb().query(
      "SELECT * FROM run_graphs WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(sessionId) as GraphRow | null
    return row ? mapGraph(row, this.listNodes(row.id), this.listEdges(row.id)) : null
  },

  listBySession(sessionId: string, limit = 50): RunGraphView[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 50
    const rows = getDb().query(
      "SELECT * FROM run_graphs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(sessionId, safeLimit) as GraphRow[]
    return rows.map((row) => mapGraph(row, this.listNodes(row.id), this.listEdges(row.id)))
  },

  graphIdForNode(nodeId: string): string | null {
    return (getDb().query("SELECT graph_id FROM run_graph_nodes WHERE id = ?").get(nodeId) as { graph_id: string } | null)?.graph_id ?? null
  },

  addNode(input: Omit<RunNodeView, "createdAt" | "updatedAt">): boolean {
    if (input.parentNodeId) {
      const parent = this.getNode(input.parentNodeId)
      if (!parent || parent.graphId !== input.graphId) {
        throw new Error("RunGraph 父节点不存在或属于其他运行图")
      }
    }
    const now = Date.now()
    return getDb().run(
      `INSERT OR IGNORE INTO run_graph_nodes
       (id, graph_id, parent_node_id, logical_task_id, attempt, kind, agent_id, status,
        contract_ref, result_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id, input.graphId, input.parentNodeId ?? null, input.logicalTaskId,
        input.attempt, input.kind, input.agentId, input.status,
        input.contractRef ?? null, input.resultRef ?? null, now, now,
      ],
    ).changes === 1
  },

  updateNode(id: string, fields: Partial<Pick<
    RunNodeView, "status" | "contractRef" | "resultRef" | "logicalTaskId" | "attempt" | "kind"
  >>): boolean {
    const sets: string[] = []
    const values: unknown[] = []
    if (fields.status) { sets.push("status = ?"); values.push(fields.status) }
    if (fields.contractRef !== undefined) { sets.push("contract_ref = ?"); values.push(fields.contractRef) }
    if (fields.resultRef !== undefined) { sets.push("result_ref = ?"); values.push(fields.resultRef) }
    if (fields.logicalTaskId !== undefined) { sets.push("logical_task_id = ?"); values.push(fields.logicalTaskId) }
    if (fields.attempt !== undefined) { sets.push("attempt = ?"); values.push(fields.attempt) }
    if (fields.kind !== undefined) { sets.push("kind = ?"); values.push(fields.kind) }
    if (sets.length === 0) return false
    sets.push("updated_at = ?")
    values.push(Date.now(), id)
    return getDb().run(`UPDATE run_graph_nodes SET ${sets.join(", ")} WHERE id = ?`, values as any[]).changes === 1
  },

  /**
   * Commit the scheduler task, graph node, root graph state and graph event as
   * one durable transition. Callers may update their in-memory state only if
   * this transaction succeeds.
   */
  transitionNodeAndTask(input: {
    task: TaskRunView
    nodeStatus: RunNodeStatus
    resultRef?: string
    eventPayload: Record<string, unknown>
  }): boolean {
    const db = getDb()
    return db.transaction(() => {
      const node = db.query(
        "SELECT graph_id, kind, status, result_ref FROM run_graph_nodes WHERE id = ?",
      ).get(input.task.id) as Pick<NodeRow, "graph_id" | "kind" | "status" | "result_ref"> | null
      if (!node) throw new Error(`RunGraph 节点不存在: ${input.task.id}`)

      const taskChanged = db.run(
        `UPDATE task_runs SET status = ?, started_at = ?, completed_at = ?, result = ?, error = ?
         WHERE id = ?`,
        [
          input.task.status,
          input.task.startedAt ?? null,
          input.task.completedAt ?? null,
          input.task.result?.slice(0, 20_000) ?? null,
          input.task.error?.slice(0, 4_000) ?? null,
          input.task.id,
        ],
      ).changes
      if (taskChanged !== 1) throw new Error(`任务持久化记录不存在: ${input.task.id}`)
      syncSessionCommandTerminal(db, input.task)

      const resultRef = input.resultRef ?? node.result_ref ?? null
      if (node.status === input.nodeStatus && node.result_ref === resultRef) return true

      const now = Date.now()
      db.run(
        "UPDATE run_graph_nodes SET status = ?, result_ref = ?, updated_at = ? WHERE id = ?",
        [input.nodeStatus, resultRef, now, input.task.id],
      )
      const graphNodes = db.query(
        "SELECT kind, status FROM run_graph_nodes WHERE graph_id = ?",
      ).all(node.graph_id) as Array<Pick<NodeRow, "kind" | "status">>
      const aggregateStatus = aggregateRunGraphStatus(graphNodes)
      const graph = db.query("SELECT version FROM run_graphs WHERE id = ?").get(node.graph_id) as { version: number } | null
      if (!graph) throw new Error(`RunGraph 不存在: ${node.graph_id}`)
      const version = graph.version + 1
      db.run(
        `UPDATE run_graphs SET status = ?, version = ?, updated_at = ? WHERE id = ?`,
        [aggregateStatus, version, now, node.graph_id],
      )
      db.run(
        `INSERT INTO run_graph_events
         (graph_id, graph_version, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
        [node.graph_id, version, "node-status", JSON.stringify(input.eventPayload), now],
      )
      return true
    })()
  },

  getNode(id: string): RunNodeView | null {
    const row = getDb().query("SELECT * FROM run_graph_nodes WHERE id = ?").get(id) as NodeRow | null
    return row ? mapNode(row) : null
  },

  removeNode(id: string): void {
    const db = getDb()
    db.transaction(() => {
      db.run("DELETE FROM run_graph_edges WHERE from_node_id = ? OR to_node_id = ?", [id, id])
      db.run("DELETE FROM run_graph_nodes WHERE id = ?", [id])
    })()
  },

  delete(id: string): void {
    getDb().run("DELETE FROM run_graphs WHERE id = ?", [id])
  },

  listNodes(graphId: string): RunNodeView[] {
    return (getDb().query(
      "SELECT * FROM run_graph_nodes WHERE graph_id = ? ORDER BY created_at ASC",
    ).all(graphId) as NodeRow[]).map(mapNode)
  },

  addEdge(input: Omit<RunEdgeView, "createdAt">): boolean {
    const from = this.getNode(input.fromNodeId)
    const to = this.getNode(input.toNodeId)
    if (!from || !to) throw new Error("RunGraph 边的端点不存在")
    if (from.graphId !== input.graphId || to.graphId !== input.graphId) {
      throw new Error("禁止创建跨运行图边")
    }
    if (input.fromNodeId === input.toNodeId) throw new Error("RunGraph 节点不能依赖自身")
    if (input.type === "depends-on" && reaches(this.listEdges(input.graphId), input.toNodeId, input.fromNodeId)) {
      throw new Error("RunGraph 依赖存在循环")
    }
    if (input.type === "revises" && this.listEdges(input.graphId).some(
      (edge) => edge.type === "revises" && edge.toNodeId === input.toNodeId && edge.fromNodeId !== input.fromNodeId,
    )) {
      throw new Error("同一任务尝试只能有一个 revision 后继")
    }
    return getDb().run(
      `INSERT OR IGNORE INTO run_graph_edges
       (graph_id, from_node_id, to_node_id, edge_type, created_at) VALUES (?, ?, ?, ?, ?)`,
      [input.graphId, input.fromNodeId, input.toNodeId, input.type, Date.now()],
    ).changes === 1
  },

  listEdges(graphId: string): RunEdgeView[] {
    return (getDb().query(
      "SELECT * FROM run_graph_edges WHERE graph_id = ? ORDER BY created_at ASC",
    ).all(graphId) as EdgeRow[]).map(mapEdge)
  },

  appendEvent(graphId: string, type: string, payload: Record<string, unknown>): RunGraphEventView {
    const db = getDb()
    return db.transaction(() => {
      const graph = db.query("SELECT version FROM run_graphs WHERE id = ?").get(graphId) as { version: number } | null
      if (!graph) throw new Error(`RunGraph 不存在: ${graphId}`)
      const version = graph.version + 1
      const now = Date.now()
      db.run("UPDATE run_graphs SET version = ?, updated_at = ? WHERE id = ?", [version, now, graphId])
      db.run(
        `INSERT INTO run_graph_events
         (graph_id, graph_version, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
        [graphId, version, type, JSON.stringify(payload), now],
      )
      return { graphId, version, type, payload, createdAt: now }
    })()
  },

  updateStatus(id: string, status: RunGraphStatus): void {
    getDb().run("UPDATE run_graphs SET status = ?, updated_at = ? WHERE id = ?", [status, Date.now(), id])
  },

  eventsAfter(graphId: string, version: number): RunGraphEventView[] {
    return (getDb().query(
      "SELECT * FROM run_graph_events WHERE graph_id = ? AND graph_version > ? ORDER BY graph_version ASC",
    ).all(graphId, Math.max(0, version)) as EventRow[]).map(mapEvent)
  },

  recoverInterrupted(): number {
    const db = getDb()
    return db.transaction(() => {
      const rows = db.query(
        `SELECT DISTINCT graph_id FROM run_graph_nodes
         WHERE status IN ('queued', 'running', 'waiting-approval', 'waiting-delegation')`,
      ).all() as Array<{ graph_id: string }>
      const now = Date.now()
      let count = 0
      for (const { graph_id: graphId } of rows) {
        const affected = db.run(
          `UPDATE run_graph_nodes SET status = 'interrupted', updated_at = ?
           WHERE graph_id = ? AND status IN ('queued', 'running', 'waiting-approval', 'waiting-delegation')`,
          [now, graphId],
        ).changes
        if (affected === 0) continue
        count += affected
        const graph = db.query("SELECT version FROM run_graphs WHERE id = ?").get(graphId) as { version: number }
        const version = graph.version + 1
        db.run(
          "UPDATE run_graphs SET status = 'interrupted', version = ?, updated_at = ? WHERE id = ?",
          [version, now, graphId],
        )
        db.run(
          `INSERT INTO run_graph_events
           (graph_id, graph_version, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
          [graphId, version, "graph-recovered", JSON.stringify({
            status: "interrupted",
            reason: "应用退出或服务重启，任务执行被中断",
            affectedNodes: affected,
          }), now],
        )
      }
      return count
    })()
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM run_graphs WHERE session_id = ?", [sessionId])
  },
}

/**
 * A graph is a tree aggregate, never a projection of whichever node happened
 * to report last. In particular, an accepted child cannot complete a running
 * root and a terminal root cannot be published while descendants remain live.
 */
export function aggregateRunGraphStatus(
  nodes: Array<Pick<RunNodeView, "kind" | "status">>,
): RunGraphStatus {
  if (nodes.length === 0) return "planned"
  const root = nodes.find((node) => node.kind === "root")
  const descendants = root ? nodes.filter((node) => node !== root) : nodes
  const live = new Set<RunNodeStatus>([
    "queued",
    "running",
    "waiting-approval",
    "waiting-delegation",
    "safety-quarantine",
  ])
  const hasLiveDescendant = descendants.some((node) => live.has(node.status))
  if (root) {
    if (hasLiveDescendant) {
      return nodes.some((node) => ["queued", "running"].includes(node.status))
        ? "running"
        : "waiting"
    }
    if (root.status === "accepted") return "completed"
    if (root.status === "failed") return "failed"
    if (root.status === "cancelled") return "cancelled"
    if (root.status === "interrupted") return "interrupted"
    if (["waiting-approval", "waiting-delegation", "safety-quarantine", "blocked"]
      .includes(root.status)) return "waiting"
    return root.status === "queued" ? "planned" : "running"
  }
  if (nodes.some((node) => ["queued", "running"].includes(node.status))) return "running"
  if (nodes.some((node) => live.has(node.status) || node.status === "blocked")) return "waiting"
  if (nodes.some((node) => node.status === "failed")) return "failed"
  if (nodes.some((node) => node.status === "interrupted")) return "interrupted"
  if (nodes.every((node) => node.status === "cancelled")) return "cancelled"
  return "completed"
}

function reaches(edges: RunEdgeView[], start: string, target: string): boolean {
  const visited = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === target) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const edge of edges) {
      if (edge.type === "depends-on" && edge.fromNodeId === current) queue.push(edge.toNodeId)
    }
  }
  return false
}

function mapGraph(row: GraphRow, nodes: RunNodeView[], edges: RunEdgeView[]): RunGraphView {
  return {
    id: row.id, sessionId: row.session_id, objective: row.objective,
    ownerInstanceId: row.owner_instance_id, status: row.status, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, nodes, edges,
  }
}
function mapNode(row: NodeRow): RunNodeView {
  return {
    id: row.id, graphId: row.graph_id, parentNodeId: row.parent_node_id ?? undefined,
    logicalTaskId: row.logical_task_id, attempt: row.attempt, kind: row.kind,
    agentId: row.agent_id, status: row.status, contractRef: row.contract_ref ?? undefined,
    resultRef: row.result_ref ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
function mapEdge(row: EdgeRow): RunEdgeView {
  return {
    graphId: row.graph_id, fromNodeId: row.from_node_id, toNodeId: row.to_node_id,
    type: row.edge_type, createdAt: row.created_at,
  }
}
function mapEvent(row: EventRow): RunGraphEventView {
  let payload: Record<string, unknown> = {}
  try { payload = JSON.parse(row.payload) as Record<string, unknown> } catch {}
  return {
    graphId: row.graph_id, version: row.graph_version, type: row.event_type,
    payload, createdAt: row.created_at,
  }
}
