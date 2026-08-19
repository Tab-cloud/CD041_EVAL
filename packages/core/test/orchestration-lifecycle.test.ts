import { describe, expect, test } from "bun:test"
import { TaskScheduler } from "../src/runtime/task-scheduler.ts"
import { settleWorkflowSiblings } from "../src/runtime/workflow-engine.ts"
import { workspaceRevisionService } from "../src/runtime/workspace-revision.ts"
import { normalizeTaskContract } from "../src/runtime/run-contract.ts"
import { getDb } from "../src/store/database.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { RunContractRepo } from "../src/store/run-contract.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"

describe("orchestration lifecycle invariants", () => {
  test("safety-quarantine barriers survive bounded terminal history eviction", () => {
    const scheduler = new TaskScheduler(2, 1)
    const writer = scheduler.enqueue({
      sessionId: "review-owner",
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "edit source",
      workingDir: ".",
      resourceClaims: { reads: [], writes: ["src"] },
    })
    expect(scheduler.quarantineForSafety(writer.id, "ready")).toBe(true)

    for (let index = 0; index < 5; index++) {
      const terminal = scheduler.enqueue({
        sessionId: `history-${index}`,
        agentId: "worker",
        priority: 1,
        type: "background",
        message: "terminal history",
        workingDir: ".",
        resourceClaims: { reads: [], writes: [`docs/${index}`] },
      })
      scheduler.completeTask(terminal.id, "done")
    }

    const conflicting = scheduler.enqueue({
      sessionId: "conflicting-owner",
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "edit same source",
      workingDir: ".",
      resourceClaims: { reads: [], writes: ["src/main.ts"] },
    })
    expect(scheduler.getSafetyBarriers().map((task) => task.id)).toContain(writer.id)
    expect(conflicting.status).toBe("queued")
  })

  test("restart keeps submitted open ChangeSets quarantined and rolls back abandoned ones", () => {
    const suffix = `${Date.now()}-${Math.random()}`
    const sessionId = `restart-changes-${suffix}`
    const rootId = `root-${suffix}`
    const reviewId = `review-${suffix}`
    const abandonedId = `abandoned-${suffix}`
    SessionRepo.create({
      id: sessionId,
      title: "recovery",
      agent_id: "main-agent",
      project_path: process.cwd(),
    })
    try {
      TaskRunRepo.create(taskView(rootId, sessionId, "interrupted", { completedAt: Date.now() }))
      TaskRunRepo.create(taskView(reviewId, sessionId, "safety-quarantine", { parentRunId: rootId }))
      RunContractRepo.create({
        runId: reviewId,
        sessionId,
        parentRunId: rootId,
        agentId: "worker",
        contract: normalizeTaskContract({
          objective: "edit source",
          instructions: "submit for review",
          acceptance: ["main Agent review"],
          resources: { reads: [], writes: ["src"] },
        }, process.cwd()),
      })
      workspaceRevisionService.open(reviewId, process.cwd())

      TaskRunRepo.create(taskView(abandonedId, sessionId, "running"))
      workspaceRevisionService.open(abandonedId, process.cwd())

      const scheduler = new TaskScheduler(2, 1, TaskRunRepo)
      expect(scheduler.recoverInterrupted()).toBe(1)
      expect(TaskRunRepo.get(reviewId)?.status).toBe("safety-quarantine")
      expect(TaskRunRepo.get(reviewId)?.error).toContain("保持隔离")
      expect(getChangeSetStatus(reviewId)).toBe("open")
      expect(TaskRunRepo.get(abandonedId)?.status).toBe("interrupted")
      expect(getChangeSetStatus(abandonedId)).toBe("rolled-back")
      expect(scheduler.getSafetyBarriers().map((task) => task.id)).toContain(reviewId)
    } finally {
      getDb().run("DELETE FROM workspace_change_sets WHERE run_id IN (?, ?)", [reviewId, abandonedId])
      getDb().run("DELETE FROM workspace_revisions WHERE workspace = ?", [process.cwd()])
      RunContractRepo.deleteBySession(sessionId)
      TaskRunRepo.deleteBySession(sessionId)
      SessionRepo.delete(sessionId)
    }
  })

  test("repeated cancel never releases a worker lease before exit acknowledgement", () => {
    const scheduler = new TaskScheduler(2, 10)
    let abortRequests = 0
    const writer = scheduler.enqueue({
      sessionId: "cancel-owner",
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "write source",
      workingDir: ".",
      resourceClaims: { reads: [], writes: ["src"] },
      onCancel: () => { abortRequests++ },
    })
    const conflicting = scheduler.enqueue({
      sessionId: "cancel-waiter",
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "write same source",
      workingDir: ".",
      resourceClaims: { reads: [], writes: ["src/index.ts"] },
    })

    expect(scheduler.cancel(writer.id)).toBe(true)
    expect(scheduler.cancel(writer.id)).toBe(true)
    expect(writer.status).toBe("cancelling")
    expect(conflicting.status).toBe("queued")
    expect(abortRequests).toBe(1)

    expect(scheduler.confirmWorkerExit(writer.id)).toBe(true)
    expect(writer.status).toBe("cancelled")
    expect(conflicting.status).toBe("running")
  })

  test("fail-fast DAG cancellation joins siblings before returning", async () => {
    const events: string[] = []
    let releaseSibling!: () => void
    const sibling = new Promise<void>((resolve) => {
      releaseSibling = () => {
        events.push("sibling-exited")
        resolve()
      }
    })
    const failed = Promise.reject(new Error("node failed"))
    const settlement = settleWorkflowSiblings([failed, sibling], "fail-fast", () => {
      events.push("cancel-requested")
      queueMicrotask(releaseSibling)
    }).then((result) => {
      events.push("joined")
      return result
    })

    const result = await settlement
    expect(result.map((item) => item.status)).toEqual(["rejected", "fulfilled"])
    expect(events).toEqual(["cancel-requested", "sibling-exited", "joined"])
  })

  test("duplicate requestId returns the original durable TaskRun without replacement", () => {
    const suffix = `${Date.now()}-${Math.random()}`
    const sessionId = `idempotent-${suffix}`
    const requestId = `request-${suffix}`
    SessionRepo.create({
      id: sessionId,
      title: "idempotency",
      agent_id: "main-agent",
      project_path: process.cwd(),
    })
    try {
      const scheduler = new TaskScheduler(2, 10, TaskRunRepo)
      const original = scheduler.enqueue({
        requestId,
        sessionId,
        agentId: "main-agent",
        priority: 8,
        type: "chat",
        message: "first payload",
        workingDir: ".",
      })
      const duplicate = scheduler.enqueue({
        requestId,
        sessionId,
        agentId: "main-agent",
        priority: 8,
        type: "chat",
        message: "different payload must not replace",
        workingDir: ".",
      })
      expect(duplicate.id).toBe(original.id)
      expect(TaskRunRepo.getByRequestId(requestId)).toMatchObject({
        id: original.id,
        message: "first payload",
      })
      expect(TaskRunRepo.listBySession(sessionId).filter((task) => task.requestId === requestId)).toHaveLength(1)
    } finally {
      TaskRunRepo.deleteBySession(sessionId)
      SessionRepo.delete(sessionId)
    }
  })
})

function taskView(
  id: string,
  sessionId: string,
  status: "running" | "safety-quarantine" | "interrupted",
  extra: { parentRunId?: string; completedAt?: number } = {},
) {
  return {
    id,
    sessionId,
    agentId: "worker",
    priority: 8,
    status,
    message: id,
    workingDir: process.cwd(),
    type: "background" as const,
    createdAt: Date.now(),
    ...extra,
  }
}

function getChangeSetStatus(runId: string): string | null {
  const row = getDb().query(
    "SELECT status FROM workspace_change_sets WHERE run_id = ?",
  ).get(runId) as { status: string } | null
  return row?.status ?? null
}
