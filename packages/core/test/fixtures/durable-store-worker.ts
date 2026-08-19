import { randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { SessionCommandRepo } from "../../src/store/session-command.ts"
import { RuntimeOwnerLeaseRepo } from "../../src/store/runtime-owner-lease.ts"
import { RuntimeLeaderLeaseRepo } from "../../src/store/runtime-leader-lease.ts"
import { RunEventRepo } from "../../src/store/run-event.ts"
import { TaskRunRepo } from "../../src/store/task-run.ts"
import { closeDb, getDb } from "../../src/store/database.ts"

const [mode, id, countText = "1"] = process.argv.slice(2)
const count = Number.parseInt(countText, 10)

try {
  if (mode === "enqueue") {
    for (let index = 0; index < count; index++) {
      const requestId = `${id}-request-${index}`
      SessionCommandRepo.enqueue({
        requestId,
        sessionId: "shared-session",
        payload: JSON.stringify({ requestId, worker: id, index }),
      })
    }
    console.log(JSON.stringify({ mode, id, count }))
  } else if (mode === "events") {
    for (let index = 0; index < count; index++) {
      RunEventRepo.append("shared-run", "shared-session", "text", {
        worker: id,
        index,
      })
    }
    console.log(JSON.stringify({ mode, id, count }))
  } else if (mode === "seed-crashed-claim") {
    const requestId = id
    const ownerEpoch = `expired-${randomUUID()}`
    const ownerToken = `owner-${randomUUID()}`
    SessionCommandRepo.enqueue({
      requestId,
      sessionId: "restart-session",
      payload: JSON.stringify({ requestId, message: "resume after crash" }),
    })
    RuntimeOwnerLeaseRepo.register(ownerEpoch, 100)
    const claimed = SessionCommandRepo.tryClaim(requestId, ownerToken, ownerEpoch)
    console.log(JSON.stringify({ state: claimed?.state, ownerEpoch }))
  } else if (mode === "recover-claim") {
    const requestId = id
    const ownerEpoch = `replacement-${randomUUID()}`
    const ownerToken = `replacement-owner-${randomUUID()}`
    RuntimeOwnerLeaseRepo.register(ownerEpoch, 10_000)
    SessionCommandRepo.recoverForProcess(requestId, ownerEpoch)
    const claimed = SessionCommandRepo.tryClaim(requestId, ownerToken, ownerEpoch)
    console.log(JSON.stringify({
      won: Boolean(claimed),
      state: SessionCommandRepo.get(requestId)?.state,
      ownerEpoch: SessionCommandRepo.get(requestId)?.ownerEpoch,
    }))
  } else if (mode === "terminal-atomic") {
    const requestId = id
    const ownerEpoch = `terminal-${randomUUID()}`
    const ownerToken = `terminal-owner-${randomUUID()}`
    const taskId = `task-${randomUUID()}`
    RuntimeOwnerLeaseRepo.register(ownerEpoch, 10_000)
    SessionCommandRepo.enqueue({
      requestId,
      sessionId: "terminal-session",
      payload: JSON.stringify({ requestId, message: "finish atomically" }),
    })
    SessionCommandRepo.tryClaim(requestId, ownerToken, ownerEpoch)
    TaskRunRepo.create({
      id: taskId,
      requestId,
      sessionId: "terminal-session",
      agentId: "main-agent",
      priority: 1,
      status: "running",
      message: "finish atomically",
      workingDir: ".",
      type: "chat",
      createdAt: Date.now(),
      startedAt: Date.now(),
    })
    SessionCommandRepo.bindTask(requestId, ownerToken, taskId)
    const task = TaskRunRepo.get(taskId)!
    TaskRunRepo.update({
      ...task,
      status: "completed",
      result: "done",
      completedAt: Date.now(),
    })
    console.log(JSON.stringify({
      taskState: TaskRunRepo.get(taskId)?.status,
      commandState: SessionCommandRepo.get(requestId)?.state,
    }))
  } else if (mode === "singleton-poison") {
    const path = join(process.env.EVAL_DATA_DIR!, "eval.db")
    const seed = new Database(path)
    seed.run(
      "CREATE TABLE _migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )
    seed.run("INSERT INTO _migrations VALUES(36, 0)")
    seed.close()
    const failures: string[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        getDb()
      } catch (error) {
        failures.push(error instanceof Error ? error.name : String(error))
      }
    }
    console.log(JSON.stringify({ failures }))
  } else if (mode === "leader-acquire") {
    const ownerEpoch = `leader-${id}-${randomUUID()}`
    console.log(JSON.stringify({
      acquired: RuntimeLeaderLeaseRepo.acquire(ownerEpoch, count),
      ownerEpoch,
    }))
  } else {
    throw new Error(`unknown worker mode: ${mode}`)
  }
} finally {
  closeDb()
}
