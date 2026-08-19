import { describe, expect, test } from "bun:test"
import { mainAgent } from "../src/agent/definitions/main-agent.ts"
import { ExecutionController } from "../src/runtime/agent-loop-control.ts"
import {
  executeDelegationDag,
  type DelegationDagNode,
  type DelegationDagNodeResult,
} from "../src/runtime/delegation-dag.ts"
import { TaskScheduler } from "../src/runtime/task-scheduler.ts"
import { aggregateRunGraphStatus } from "../src/store/run-graph.ts"
import { NO_PROGRESS_SEMANTICS } from "../src/runtime/tool-execution-semantics.ts"
import { delegateDagTool } from "../src/tool/general/delegate-dag.ts"
import {
  awaitCooperativeWorkerExit,
  WorkerExitPendingError,
} from "../src/tool/general/task.ts"

type Payload = { delay: number }

describe("atomic main-Agent delegation DAG", () => {
  test("independent nodes execute concurrently and parent resumes exactly once", async () => {
    let active = 0
    let peak = 0
    let suspends = 0
    let resumes = 0
    const result = await executeDelegationDag([
      node("a", [], ["a.c"], 20),
      node("b", [], ["b.c"], 20),
    ], {
      suspendParent: () => { suspends++; return true },
      resumeParent: async () => { resumes++ },
      runNode: async (item) => {
        active++
        peak = Math.max(peak, active)
        await delay(item.payload.delay)
        active--
        return { nodeId: item.id, success: true, value: item.id }
      },
      cancelNode: () => "exited",
    })

    expect(result.success).toBe(true)
    expect(peak).toBeGreaterThanOrEqual(2)
    expect(suspends).toBe(1)
    expect(resumes).toBe(1)
  })

  test("conflicting writers serialize even when dependency-independent", async () => {
    let active = 0
    let peak = 0
    const result = await executeDelegationDag([
      node("a", [], ["shared/file.c"], 15),
      node("b", [], ["shared/file.c"], 15),
    ], hooks(async (item) => {
      active++
      peak = Math.max(peak, active)
      await delay(item.payload.delay)
      active--
      return { nodeId: item.id, success: true }
    }))

    expect(result.success).toBe(true)
    expect(peak).toBe(1)
  })

  test("dependency nodes start only after predecessors complete", async () => {
    const order: string[] = []
    const result = await executeDelegationDag([
      node("inspect", [], [], 10),
      node("change", ["inspect"], [], 1),
    ], hooks(async (item) => {
      order.push(`start:${item.id}`)
      await delay(item.payload.delay)
      order.push(`end:${item.id}`)
      return { nodeId: item.id, success: true }
    }))

    expect(result.success).toBe(true)
    expect(order).toEqual([
      "start:inspect", "end:inspect",
      "start:change", "end:change",
    ])
  })

  test("failure preserves independent sibling results and resumes once", async () => {
    let cancelCalls = 0
    let resumes = 0
    const result = await executeDelegationDag([
      node("fails", [], ["a.c"], 5),
      node("sibling", [], ["b.c"], 50),
    ], {
      suspendParent: () => true,
      resumeParent: async () => { resumes++ },
      runNode: async (item) => {
        if (item.id === "fails") {
          await delay(5)
          return { nodeId: item.id, success: false, error: "injected failure" }
        }
        await delay(20)
        return { nodeId: item.id, success: true, value: "independent result" }
      },
      cancelNode: () => { cancelCalls++; return "exited" },
    })

    expect(result.success).toBe(false)
    expect(result.failedNodeId).toBe("fails")
    expect(result.results.find((item) => item.nodeId === "sibling")).toMatchObject({
      success: true,
      value: "independent result",
    })
    expect(cancelCalls).toBe(0)
    expect(resumes).toBe(1)
  })

  test("failed dependencies are skipped while other branches continue", async () => {
    const started: string[] = []
    const result = await executeDelegationDag([
      node("fails", [], ["a.c"], 1),
      node("dependent", ["fails"], ["b.c"], 1),
      node("independent", [], ["c.c"], 1),
    ], hooks(async (item) => {
      started.push(item.id)
      return item.id === "fails"
        ? { nodeId: item.id, success: false, error: "injected failure" }
        : { nodeId: item.id, success: true }
    }))

    expect(result.success).toBe(false)
    expect(started).toContain("independent")
    expect(started).not.toContain("dependent")
    expect(result.results.find((item) => item.nodeId === "dependent")).toMatchObject({
      success: false,
      skipped: true,
    })
  })

  test("subagents cannot create an orchestration DAG", async () => {
    const result = await delegateDagTool.execute({
      nodes: [{
        id: "child",
        description: "forbidden",
        subagent: "general",
        acceptance: ["must not run"],
      }],
    }, {
      runType: "subagent",
      sessionId: "session",
      agentId: "general",
      workingDir: process.cwd(),
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("主 Agent")
    expect(mainAgent.tools).toContain("delegate_dag")
  })

  test("unknown agents and cyclic dependencies fail before parent suspension", async () => {
    const baseContext = {
      runType: "root" as const,
      sessionId: "session",
      agentId: "main-agent",
      workingDir: process.cwd(),
      toolRegistry: {},
      modelRouter: {},
    }
    const unknown = await delegateDagTool.execute({
      nodes: [{
        id: "unknown",
        description: "unknown",
        subagent: "missing",
        acceptance: ["verified"],
      }],
    }, {
      ...baseContext,
      agentRegistry: { get: () => undefined },
    } as any)
    expect(unknown.success).toBe(false)
    expect(unknown.error).toContain("不存在")

    const cyclic = await delegateDagTool.execute({
      nodes: [
        { id: "a", description: "a", subagent: "worker", acceptance: ["a"], depends_on: ["b"] },
        { id: "b", description: "b", subagent: "worker", acceptance: ["b"], depends_on: ["a"] },
      ],
    }, {
      ...baseContext,
      agentRegistry: { get: () => ({ id: "worker", mode: "hidden" }) },
    } as any)
    expect(cyclic.success).toBe(false)
    expect(cyclic.error).toContain("循环依赖")
  })

  test("a DAG cannot start when the parent did not enter waiting-delegation", async () => {
    let started = 0
    let resumed = 0
    await expect(executeDelegationDag([
      node("orphan", [], [], 1),
    ], {
      suspendParent: () => false,
      resumeParent: async () => { resumed++ },
      runNode: async (item) => {
        started++
        return { nodeId: item.id, success: true }
      },
      cancelNode: () => "exited",
    })).rejects.toThrow("拒绝启动无 owner")
    expect(started).toBe(0)
    expect(resumed).toBe(0)
  })

  test("parent cancellation reports an unresponsive worker without stranding the parent", async () => {
    let resumes = 0
    const parent = new AbortController()
    const never = new Promise<DelegationDagNodeResult<string>>(() => {})
    const execution = executeDelegationDag([
      node("quick", [], ["a.c"], 1),
      node("never-exits", [], ["b.c"], 1),
    ], {
      suspendParent: () => true,
      resumeParent: async () => { resumes++ },
      runNode: async (item) => item.id === "quick"
        ? { nodeId: item.id, success: true, value: "quick" }
        : never,
      cancelNode: (id) => id === "never-exits" ? "pending" : "exited",
    }, parent.signal, { cancellationJoinMs: 5 })
    await delay(5)
    parent.abort()
    const result = await execution
    expect(result.success).toBe(false)
    expect(result.waitingWorkerExitNodeIds).toContain("never-exits")
    expect(result.results.find((item) => item.nodeId === "never-exits")?.error)
      .toContain("资源租约继续保留")
    expect(resumes).toBe(1)
  })

  test("partial DAG results remain model-facing data and do not create a review gate", () => {
    const controller = new ExecutionController(8, 20, 60_000)
    controller.observe([{
      name: "delegate_dag",
      result: {
        success: true,
        data: {
          status: "partial",
          results: [
            { runId: "run-a", logicalTaskId: "logical-a", status: "completed" },
            { logicalTaskId: "logical-b", status: "failed", error: "injected" },
          ],
        },
      },
      semantics: NO_PROGRESS_SEMANTICS,
    }])
    expect(controller.outstandingWorkSummary().total).toBe(0)
    expect(controller.onModelYield()).toBe("complete")
  })
})

describe("non-cooperative delegated worker lease", () => {
  test("a competing writer remains queued until the real worker exit is confirmed", async () => {
    const scheduler = new TaskScheduler(2)
    const first = scheduler.enqueue({
      sessionId: "session",
      agentId: "worker-a",
      priority: 5,
      type: "background",
      message: "first writer",
      workingDir: process.cwd(),
      resourceClaims: { reads: [], writes: ["shared/file.c"] },
      onCancel: () => {},
    })
    expect(first.status).toBe("running")
    scheduler.cancel(first.id)

    const second = scheduler.enqueue({
      sessionId: "session",
      agentId: "worker-b",
      priority: 5,
      type: "background",
      message: "second writer",
      workingDir: process.cwd(),
      resourceClaims: { reads: [], writes: ["shared/file.c"] },
    })
    expect(second.status).toBe("queued")

    const worker = deferred<void>()
    const abort = new AbortController()
    abort.abort()
    await expect(awaitCooperativeWorkerExit(worker.promise, abort.signal, 2))
      .rejects.toBeInstanceOf(WorkerExitPendingError)
    expect(scheduler.getTask(first.id)?.status).toBe("cancelling")
    expect(scheduler.getTask(second.id)?.status).toBe("queued")

    worker.resolve()
    await worker.promise
    scheduler.confirmWorkerExit(first.id, "fault-injected worker exited")
    expect(scheduler.getTask(first.id)?.status).toBe("cancelled")
    expect(scheduler.getTask(second.id)?.status).toBe("running")
  })
})

describe("tree terminal barrier", () => {
  test("root completion waits for an active child and closes automatically after child exit", () => {
    const scheduler = new TaskScheduler(2)
    const root = scheduledRoot(scheduler, "complete-tree")
    const child = scheduledChild(scheduler, root, "complete-tree-child")
    expect(root.status).toBe("running")
    expect(child.status).toBe("running")

    scheduler.completeTask(root.id, "root worker returned")
    expect(scheduler.getTask(root.id)?.status).toBe("waiting-delegation")
    expect(scheduler.getTask(root.id)?.completedAt).toBeUndefined()

    scheduler.completeTask(child.id, "child exited")
    expect(scheduler.getTask(child.id)?.status).toBe("completed")
    expect(scheduler.getTask(root.id)?.status).toBe("completed")
  })

  test("root cancellation retains its owner until a non-cooperative child really exits", () => {
    const scheduler = new TaskScheduler(2)
    const root = scheduledRoot(scheduler, "cancel-tree", () => {})
    const child = scheduledChild(scheduler, root, "cancel-tree-child", () => {})

    expect(scheduler.cancel(root.id)).toBe(true)
    expect(scheduler.getTask(root.id)?.status).toBe("cancelling")
    expect(scheduler.getTask(child.id)?.status).toBe("cancelling")

    expect(scheduler.confirmWorkerExit(root.id, "root exited")).toBe(true)
    expect(scheduler.getTask(root.id)?.status).toBe("cancelling")
    expect(scheduler.getTask(root.id)?.completedAt).toBeUndefined()

    expect(scheduler.confirmWorkerExit(child.id, "child exited")).toBe(true)
    expect(scheduler.getTask(child.id)?.status).toBe("cancelled")
    expect(scheduler.getTask(root.id)?.status).toBe("cancelled")
  })

  test("root failure cancels descendants and cannot release before their worker exit", () => {
    const scheduler = new TaskScheduler(2)
    const root = scheduledRoot(scheduler, "fail-tree")
    const child = scheduledChild(scheduler, root, "fail-tree-child", () => {})

    scheduler.failTask(root.id, "root failed")
    expect(scheduler.getTask(root.id)?.status).toBe("cancelling")
    expect(scheduler.getTask(child.id)?.status).toBe("cancelling")

    scheduler.confirmWorkerExit(child.id, "child exited")
    expect(scheduler.getTask(root.id)?.status).toBe("failed")
    expect(scheduler.getTask(root.id)?.error).toBe("root failed")
  })

  test("safety-quarantine is an active descendant barrier for root completion", () => {
    const scheduler = new TaskScheduler(2)
    const root = scheduledRoot(scheduler, "review-tree")
    const child = scheduledChild(scheduler, root, "review-tree-child")
    expect(scheduler.quarantineForSafety(child.id, "cleanup required")).toBe(true)

    scheduler.completeTask(root.id, "root worker returned")
    expect(scheduler.getTask(root.id)?.status).toBe("waiting-delegation")
    expect(scheduler.getTask(child.id)?.status).toBe("safety-quarantine")

    expect(scheduler.cancel(child.id)).toBe(true)
    expect(scheduler.getTask(root.id)?.status).toBe("completed")
  })
})

describe("run graph aggregate status", () => {
  test("accepted child cannot complete a running root graph", () => {
    expect(aggregateRunGraphStatus([
      graphNode("root", "running"),
      graphNode("delegated", "accepted"),
    ])).toBe("running")
  })

  test("child review state keeps the graph waiting when the root is suspended", () => {
    expect(aggregateRunGraphStatus([
      graphNode("root", "waiting-delegation"),
      graphNode("delegated", "safety-quarantine"),
    ])).toBe("waiting")
  })

  test("a cancelling root remains nonterminal while a child is alive", () => {
    expect(aggregateRunGraphStatus([
      graphNode("root", "running"),
      graphNode("delegated", "running"),
    ])).toBe("running")
  })
})

function node(
  id: string,
  dependsOn: string[],
  writes: string[],
  delayMs: number,
): DelegationDagNode<Payload> {
  return {
    id,
    dependsOn,
    resources: { reads: [], writes },
    payload: { delay: delayMs },
  }
}

function hooks(
  runNode: Parameters<typeof executeDelegationDag<Payload, unknown>>[1]["runNode"],
): Parameters<typeof executeDelegationDag<Payload, unknown>>[1] {
  return {
    suspendParent: () => true,
    resumeParent: async () => {},
    runNode,
    cancelNode: () => "exited",
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function scheduledRoot(
  scheduler: TaskScheduler,
  label: string,
  onCancel?: () => void,
) {
  return scheduler.enqueue({
    sessionId: label,
    agentId: "main-agent",
    priority: 8,
    type: "chat",
    message: label,
    workingDir: process.cwd(),
    laneOwner: label,
    onCancel,
  })
}

function scheduledChild(
  scheduler: TaskScheduler,
  root: ReturnType<typeof scheduledRoot>,
  label: string,
  onCancel?: () => void,
) {
  return scheduler.enqueue({
    parentRunId: root.id,
    sessionId: root.sessionId,
    agentId: "worker",
    priority: 8,
    type: "background",
    message: label,
    workingDir: process.cwd(),
    laneOwner: root.laneOwner,
    onCancel,
  })
}

function graphNode(
  kind: "root" | "delegated",
  status: Parameters<typeof aggregateRunGraphStatus>[0][number]["status"],
) {
  return { kind, status }
}
