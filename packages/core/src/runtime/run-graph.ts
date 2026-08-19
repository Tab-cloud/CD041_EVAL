import type { ScheduledTask } from "./task-scheduler.ts"
import { RunGraphRepo, type RunEdgeType, type RunNodeKind, type RunNodeStatus } from "../store/run-graph.ts"
import { SessionRepo } from "../store/repository.ts"
import type { TaskContract } from "./run-contract.ts"

const STATUS_MAP: Record<string, RunNodeStatus> = {
  queued: "queued",
  running: "running",
  cancelling: "running",
  "waiting-approval": "waiting-approval",
  "waiting-delegation": "waiting-delegation",
  "safety-quarantine": "safety-quarantine",
  blocked: "blocked",
  completed: "accepted",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
}

export const runGraphService = {
  recoverInterrupted(): number {
    return RunGraphRepo.recoverInterrupted()
  },

  ensureRoot(input: {
    id: string; sessionId: string; objective: string; agentId?: string; status?: RunNodeStatus
  }): void {
    if (RunGraphRepo.get(input.id)) return
    const session = SessionRepo.get(input.sessionId)
    if (!session) throw new Error(`RunGraph 会话不存在: ${input.sessionId}`)
    RunGraphRepo.create({
      id: input.id,
      sessionId: input.sessionId,
      objective: input.objective,
      ownerInstanceId: session.main_agent_instance_id,
      status: input.status === "queued" ? "planned" : "running",
    })
    RunGraphRepo.addNode({
      id: input.id,
      graphId: input.id,
      logicalTaskId: input.id,
      attempt: 1,
      kind: "root",
      agentId: input.agentId ?? "main-agent",
      status: input.status ?? "queued",
    })
    RunGraphRepo.appendEvent(input.id, "graph-created", {
      rootNodeId: input.id,
      ownerInstanceId: session.main_agent_instance_id,
    })
  },

  observeEnqueue(task: ScheduledTask): void {
      const session = SessionRepo.get(task.sessionId)
      if (!session) throw new Error(`RunGraph 会话不存在: ${task.sessionId}`)
      const parentGraphId = task.parentRunId
        ? RunGraphRepo.graphIdForNode(task.parentRunId) ?? (RunGraphRepo.get(task.parentRunId) ? task.parentRunId : null)
        : null
      const graphId = parentGraphId ?? task.id
      RunGraphRepo.create({
        id: graphId,
        sessionId: task.sessionId,
        objective: task.message,
        ownerInstanceId: session.main_agent_instance_id,
        status: "running",
      })
      const kind: RunNodeKind = task.type === "chat" ? "root"
        : task.parentRunId?.startsWith("workflow-") ? "workflow" : "delegated"
      if (RunGraphRepo.addNode({
        id: task.id, graphId, parentNodeId: task.parentRunId,
        logicalTaskId: task.id, attempt: 1, kind, agentId: task.agentId,
        status: STATUS_MAP[task.status] ?? "queued",
      })) {
        RunGraphRepo.appendEvent(graphId, "node-added", { nodeId: task.id, kind, status: task.status })
      }
      if (task.parentRunId && kind === "delegated" && RunGraphRepo.getNode(task.parentRunId)) {
        this.addEdge(graphId, task.id, task.parentRunId, "blocks")
      }
  },

  observeStatus(task: ScheduledTask): boolean {
      const node = RunGraphRepo.getNode(task.id)
      if (!node) throw new Error(`RunGraph 节点不存在: ${task.id}`)
      const status = STATUS_MAP[task.status] ?? "interrupted"
      const resultRef = task.result ? `task-result:${task.id}` : node.resultRef
      return RunGraphRepo.transitionNodeAndTask({
        task,
        nodeStatus: status,
        resultRef,
        eventPayload: {
          nodeId: task.id, status, error: task.error?.slice(0, 1_000),
        },
      })
  },

  bindContract(runId: string, contract: TaskContract): void {
      const node = RunGraphRepo.getNode(runId)
      if (!node) throw new Error(`RunGraph 节点不存在: ${runId}`)
      RunGraphRepo.updateNode(runId, {
        contractRef: `run-contract:${runId}`,
        resultRef: undefined,
        logicalTaskId: contract.logicalTaskId ?? runId,
        attempt: contract.attempt ?? 1,
        kind: node.kind,
      })
      if (contract.logicalTaskId || contract.attempt) {
        // Normalized identity is persisted in run_contracts; graph events retain
        // the binding without duplicating an independently mutable contract.
        RunGraphRepo.appendEvent(node.graphId, "contract-bound", {
          nodeId: runId,
          logicalTaskId: contract.logicalTaskId ?? runId,
          attempt: contract.attempt ?? 1,
        })
      }
      if (contract.revisionOf) this.addEdge(node.graphId, runId, contract.revisionOf, "revises")
  },

  rollbackEnqueue(task: ScheduledTask): void {
    const node = RunGraphRepo.getNode(task.id)
    if (!node) return
    if (node.kind === "root" && RunGraphRepo.listNodes(node.graphId).length === 1) RunGraphRepo.delete(node.graphId)
    else RunGraphRepo.removeNode(task.id)
  },

  cancelNode(nodeId: string): string[] {
    const node = RunGraphRepo.getNode(nodeId)
    if (!node) throw new Error(`RunGraph 节点不存在: ${nodeId}`)
    const nodes = RunGraphRepo.listNodes(node.graphId)
    const targetIds = new Set([nodeId])
    if (node.kind === "root") {
      for (const candidate of nodes) targetIds.add(candidate.id)
    } else {
      let changed = true
      while (changed) {
        changed = false
        for (const candidate of nodes) {
          if (candidate.parentNodeId && targetIds.has(candidate.parentNodeId) && !targetIds.has(candidate.id)) {
            targetIds.add(candidate.id)
            changed = true
          }
        }
      }
    }
    const cancelled: string[] = []
    for (const candidate of nodes) {
      if (!targetIds.has(candidate.id) || isTerminal(candidate.status)) continue
      RunGraphRepo.updateNode(candidate.id, { status: "cancelled" })
      cancelled.push(candidate.id)
    }
    if (cancelled.length > 0) {
      if (node.kind === "root") RunGraphRepo.updateStatus(node.graphId, "cancelled")
      RunGraphRepo.appendEvent(node.graphId, "nodes-cancelled", { requestedNodeId: nodeId, nodeIds: cancelled })
    }
    return cancelled
  },

  addEdge(graphId: string, fromNodeId: string, toNodeId: string, type: RunEdgeType): void {
    if (fromNodeId === toNodeId) return
    if (RunGraphRepo.addEdge({ graphId, fromNodeId, toNodeId, type })) {
      RunGraphRepo.appendEvent(graphId, "edge-added", { fromNodeId, toNodeId, type })
    }
  },
}

function isTerminal(status: RunNodeStatus): boolean {
  return ["accepted", "failed", "cancelled", "interrupted"].includes(status)
}
