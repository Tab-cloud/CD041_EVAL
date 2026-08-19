import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  startSessionCommandDispatcher,
  stopSessionCommandDispatcher,
} from "../src/runtime/session-command-dispatcher.ts"
import {
  acquireSessionCommand,
  SESSION_COMMAND_PROCESS_EPOCH,
} from "../src/runtime/session-command-queue.ts"
import { commandSubscriptionResponse } from "../src/runtime/session-command-subscription.ts"
import {
  SessionCommandConflictError,
  SessionCommandRepo,
} from "../src/store/session-command.ts"
import { RuntimeOwnerLeaseRepo } from "../src/store/runtime-owner-lease.ts"
import { handleTaskRoutes } from "../src/runtime/server-tasks.ts"
import { taskScheduler } from "../src/runtime/task-scheduler.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { RunEventRepo } from "../src/store/run-event.ts"

const sessions = new Set<string>()

afterEach(() => {
  stopSessionCommandDispatcher()
  for (const sessionId of sessions) {
    SessionCommandRepo.deleteBySession(sessionId)
    TaskRunRepo.deleteBySession(sessionId)
    SessionRepo.delete(sessionId)
  }
  sessions.clear()
})

describe("durable session command queue", () => {
  test("attachment-only admission receives a stable executable message", async () => {
    const sessionId = trackedSession()
    const requestId = randomUUID()
    const request = new Request("http://eval.local/api/session-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        sessionId,
        message: "",
        displayMessage: "",
        attachments: [{
          name: "schematic.pdf",
          size: 1,
          mime: "application/pdf",
          kind: "binary",
          uploadId: "a".repeat(64),
        }],
        effort: "on",
      }),
    })

    const response = await handleTaskRoutes(request, new URL(request.url), {})
    expect(response?.status).toBe(202)
    expect(JSON.parse(SessionCommandRepo.get(requestId)!.payload).message)
      .toBe("请分析随附文件。")
  })

  test("requestId is idempotent and concurrent claims have one owner", async () => {
    const sessionId = trackedSession()
    const requestId = randomUUID()
    const payload = JSON.stringify({ sessionId, requestId, message: "compile" })

    const inserted = await Promise.all(Array.from({ length: 16 }, async () =>
      SessionCommandRepo.enqueue({ sessionId, requestId, payload })))
    expect(inserted.filter((result) => result.inserted)).toHaveLength(1)
    expect(new Set(inserted.map((result) => result.command.sessionSeq))).toEqual(new Set([1]))

    const claims = await Promise.all(Array.from({ length: 16 }, async (_, index) =>
      SessionCommandRepo.tryClaim(requestId, `owner-${index}`, SESSION_COMMAND_PROCESS_EPOCH)))
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  test("requestId cannot be rebound to another session or payload", () => {
    const sessionId = trackedSession()
    const otherSessionId = trackedSession()
    const command = enqueue(sessionId, "original")

    expect(() => SessionCommandRepo.enqueue({
      requestId: command.requestId,
      sessionId: otherSessionId,
      payload: command.payload,
    })).toThrow(SessionCommandConflictError)
    expect(() => SessionCommandRepo.enqueue({
      requestId: command.requestId,
      sessionId,
      payload: JSON.stringify({ sessionId, requestId: command.requestId, message: "changed" }),
    })).toThrow(SessionCommandConflictError)
  })

  test("dispatcher is the single consumer and preserves semantic FIFO", async () => {
    const sessionId = trackedSession()
    const first = enqueue(sessionId, "first")
    const second = enqueue(sessionId, "second")
    const executions: string[] = []

    const subscription = commandSubscriptionResponse(first.requestId, sessionId, {})
    startSessionCommandDispatcher(async (request) => {
      const body = await request.json() as { requestId: string; message: string }
      const owner = randomUUID()
      const claimed = await acquireSessionCommand(body.requestId, owner)
      expect(claimed.ownerToken).toBe(owner)
      executions.push(body.message)
      SessionCommandRepo.finish(body.requestId, "completed")
      return new Response(null, { status: 200 })
    })

    await waitFor(() =>
      SessionCommandRepo.get(first.requestId)?.state === "completed"
      && SessionCommandRepo.get(second.requestId)?.state === "completed")
    const replay = await subscription.text()

    expect(executions).toEqual(["first", "second"])
    expect(replay).toContain("event: done")
    expect(replay).toContain(`"requestId":"${first.requestId}"`)
  })

  test("a terminal command drains every durable event page before closing the subscriber", async () => {
    const sessionId = trackedSession()
    const command = enqueue(sessionId, "large streamed response")
    const owner = randomUUID()
    expect(SessionCommandRepo.tryClaim(
      command.requestId,
      owner,
      SESSION_COMMAND_PROCESS_EPOCH,
    )?.state).toBe("processing")
    const task = taskScheduler.enqueue({
      requestId: command.requestId,
      sessionId,
      agentId: "main-agent",
      priority: 8,
      type: "chat",
      message: "large streamed response",
      workingDir: ".",
    })
    expect(SessionCommandRepo.bindTask(command.requestId, owner, task.id)?.state).toBe("accepted")

    for (let index = 0; index < 501; index++) {
      RunEventRepo.append(task.id, sessionId, "assistant-part", {
        requestId: command.requestId,
        partId: "text:large-response",
        partType: "text",
        status: "delta",
        text: String(index % 10),
        timestamp: Date.now(),
      }, 3)
    }
    RunEventRepo.append(task.id, sessionId, "assistant-part", {
      requestId: command.requestId,
      partId: "text:large-response",
      partType: "text",
      status: "end",
      outcome: "completed",
      timestamp: Date.now(),
    }, 3)
    RunEventRepo.append(task.id, sessionId, "done", {
      kind: "done",
      requestId: command.requestId,
      taskId: task.id,
      status: "completed",
      result: "authoritative terminal",
    }, 3)
    taskScheduler.completeTask(task.id, "authoritative terminal")

    const replay = await commandSubscriptionResponse(command.requestId, sessionId, {}).text()

    expect(replay).toContain('"status":"end"')
    expect(replay).toContain('"result":"authoritative terminal"')
    expect(replay.match(/event: done/g)).toHaveLength(1)
  })

  test("a slow command keeps the next command in the same session pending", async () => {
    const sessionId = trackedSession()
    const first = enqueue(sessionId, "slow first")
    const second = enqueue(sessionId, "second")
    const executions: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    startSessionCommandDispatcher(async (request) => {
      const body = await request.json() as {
        requestId: string
        message: string
      }
      const owner = randomUUID()
      await acquireSessionCommand(body.requestId, owner)
      executions.push(body.message)
      if (body.requestId === first.requestId) await firstGate
      SessionCommandRepo.finish(body.requestId, "completed")
      return new Response("event: done\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    })

    await waitFor(() => executions.length === 1)
    await Bun.sleep(350)
    expect(executions).toEqual(["slow first"])
    expect(SessionCommandRepo.get(second.requestId)?.state).toBe("pending")

    releaseFirst()
    await waitFor(() =>
      SessionCommandRepo.get(first.requestId)?.state === "completed"
      && SessionCommandRepo.get(second.requestId)?.state === "completed")
    expect(executions).toEqual(["slow first", "second"])
  })

  test("subscriber disconnect does not cancel or consume the command", async () => {
    const sessionId = trackedSession()
    const command = enqueue(sessionId, "background")
    const response = commandSubscriptionResponse(command.requestId, sessionId, {})
    const reader = response.body!.getReader()
    await reader.cancel()

    expect(SessionCommandRepo.get(command.requestId)?.state).toBe("pending")
    const claimed = SessionCommandRepo.tryClaim(
      command.requestId,
      "dispatcher-owner",
      SESSION_COMMAND_PROCESS_EPOCH,
    )
    expect(claimed?.state).toBe("processing")
  })

  test("two active process epochs never steal each other's command", () => {
    const sessionId = trackedSession()
    const command = enqueue(sessionId, "shared database")
    const otherEpoch = `live-process-${randomUUID()}`
    RuntimeOwnerLeaseRepo.register(otherEpoch, 60_000)
    expect(SessionCommandRepo.tryClaim(command.requestId, "live-owner", otherEpoch)?.state)
      .toBe("processing")

    const untouched = SessionCommandRepo.recoverForProcess(
      command.requestId,
      SESSION_COMMAND_PROCESS_EPOCH,
    )
    expect(untouched).toMatchObject({
      state: "processing",
      ownerToken: "live-owner",
      ownerEpoch: otherEpoch,
    })
    RuntimeOwnerLeaseRepo.retire(otherEpoch)
  })

  test("an expired owner lease makes a crashed process claim recoverable", () => {
    const sessionId = trackedSession()
    const command = enqueue(sessionId, "resume")
    const deadEpoch = `dead-process-${randomUUID()}`
    RuntimeOwnerLeaseRepo.register(deadEpoch, 60_000)
    expect(SessionCommandRepo.tryClaim(command.requestId, "dead-owner", deadEpoch)?.state)
      .toBe("processing")
    RuntimeOwnerLeaseRepo.retire(deadEpoch)

    const recovered = SessionCommandRepo.recoverForProcess(
      command.requestId,
      SESSION_COMMAND_PROCESS_EPOCH,
    )
    expect(recovered).toMatchObject({
      state: "pending",
      ownerToken: undefined,
      ownerEpoch: undefined,
    })
  })

  test("an expired owner is fenced and cannot bind or finish after replacement", async () => {
    const sessionId = trackedSession()
    const command = enqueue(sessionId, "fence stale owner")
    const staleEpoch = `stale-process-${randomUUID()}`
    const staleOwner = `stale-owner-${randomUUID()}`
    RuntimeOwnerLeaseRepo.register(staleEpoch, 25)
    expect(SessionCommandRepo.tryClaim(command.requestId, staleOwner, staleEpoch)?.state)
      .toBe("processing")
    await Bun.sleep(35)

    expect(RuntimeOwnerLeaseRepo.heartbeat(staleEpoch, 60_000)).toBe(false)
    expect(SessionCommandRepo.bindTask(
      command.requestId,
      staleOwner,
      `stale-task-${randomUUID()}`,
    )).toBeNull()

    const replacementEpoch = `replacement-process-${randomUUID()}`
    const replacementOwner = `replacement-owner-${randomUUID()}`
    RuntimeOwnerLeaseRepo.register(replacementEpoch, 60_000)
    expect(SessionCommandRepo.recoverForProcess(
      command.requestId,
      replacementEpoch,
    )?.state).toBe("pending")
    expect(SessionCommandRepo.tryClaim(
      command.requestId,
      replacementOwner,
      replacementEpoch,
    )?.ownerToken).toBe(replacementOwner)

    expect(SessionCommandRepo.finishOwned(
      command.requestId,
      staleOwner,
      "failed",
      "stale completion",
    )).toBeNull()
    expect(SessionCommandRepo.finishOwned(
      command.requestId,
      replacementOwner,
      "completed",
    )?.state).toBe("completed")
  })

  test("non-success and empty executor responses terminate instead of replaying forever", async () => {
    const sessionId = trackedSession()
    const failed = enqueue(sessionId, "http failure")
    let attempts = 0
    startSessionCommandDispatcher(async () => {
      attempts++
      return new Response("upstream unavailable", { status: 503 })
    })

    await waitFor(() => SessionCommandRepo.get(failed.requestId)?.state === "failed")
    await Bun.sleep(350)
    expect(attempts).toBe(1)
    expect(SessionCommandRepo.get(failed.requestId)?.error).toContain("HTTP 503")

    stopSessionCommandDispatcher()
    const empty = enqueue(sessionId, "empty stream")
    startSessionCommandDispatcher(async () => new Response(null, { status: 200 }))
    await waitFor(() => SessionCommandRepo.get(empty.requestId)?.state === "failed")
    expect(SessionCommandRepo.get(empty.requestId)?.error).toContain("未返回事件流")
  })

  test("an orphaned accepted head is reconciled before the next command starts", async () => {
    const sessionId = trackedSession()
    const orphaned = enqueue(sessionId, "orphaned accepted")
    const successor = enqueue(sessionId, "successor")
    const owner = randomUUID()
    expect(SessionCommandRepo.tryClaim(
      orphaned.requestId,
      owner,
      SESSION_COMMAND_PROCESS_EPOCH,
    )?.state).toBe("processing")
    expect(SessionCommandRepo.bindTask(
      orphaned.requestId,
      owner,
      `missing-root-${randomUUID()}`,
    )?.state).toBe("accepted")
    const executions: string[] = []

    startSessionCommandDispatcher(async (request) => {
      const body = await request.json() as { requestId: string; message: string }
      const commandOwner = randomUUID()
      await acquireSessionCommand(body.requestId, commandOwner)
      executions.push(body.message)
      SessionCommandRepo.finishOwned(body.requestId, commandOwner, "completed")
      return new Response("event: done\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    })

    await waitFor(() =>
      SessionCommandRepo.get(orphaned.requestId)?.state === "failed"
      && SessionCommandRepo.get(successor.requestId)?.state === "completed")
    expect(executions).toEqual(["successor"])
  })

  test("queue removal cancels the durable command instead of only hiding UI state", async () => {
    const sessionId = trackedSession()
    const command = enqueue(sessionId, "remove me")
    const request = new Request(
      `http://eval.local/api/session-commands?requestId=${encodeURIComponent(command.requestId)}`,
      { method: "DELETE" },
    )
    const response = await handleTaskRoutes(request, new URL(request.url), {})

    expect(response?.status).toBe(200)
    expect(SessionCommandRepo.get(command.requestId)?.state).toBe("cancelled")
  })

  test("running command cancellation stays non-terminal until the worker exits", async () => {
    const sessionId = trackedSession()
    const command = enqueue(sessionId, "cancel running")
    const owner = randomUUID()
    expect(SessionCommandRepo.tryClaim(
      command.requestId,
      owner,
      SESSION_COMMAND_PROCESS_EPOCH,
    )?.state).toBe("processing")
    const task = taskScheduler.enqueue({
      requestId: command.requestId,
      sessionId,
      agentId: "main-agent",
      priority: 8,
      type: "chat",
      message: "cancel running",
      workingDir: ".",
      onCancel: () => undefined,
    })
    expect(task.status).toBe("running")
    expect(SessionCommandRepo.bindTask(command.requestId, owner, task.id)?.state).toBe("accepted")

    const request = new Request(
      `http://eval.local/api/session-commands?requestId=${encodeURIComponent(command.requestId)}`,
      { method: "DELETE" },
    )
    const response = await handleTaskRoutes(request, new URL(request.url), {})
    const payload = await response?.json() as {
      cancellationPending?: boolean
      command?: { state?: string }
    }

    expect(response?.status).toBe(202)
    expect(payload.cancellationPending).toBe(true)
    expect(taskScheduler.getTask(task.id)?.status).toBe("cancelling")
    expect(payload.command?.state).toBe("accepted")
    expect(SessionCommandRepo.get(command.requestId)?.completedAt).toBeUndefined()

    // Mirrors server-chat's worker finally: only the exit acknowledgement may
    // release the lane and publish the durable command terminal.
    expect(taskScheduler.confirmWorkerExit(task.id, "test worker exited")).toBe(true)
    expect(SessionCommandRepo.get(command.requestId)?.state).toBe("cancelled")
    expect(SessionCommandRepo.finish(command.requestId, "cancelled")?.state).toBe("cancelled")
  })

  test("a duplicate dispatcher response cannot fail another live owner's task", async () => {
    const sessionId = trackedSession()
    const command = enqueue(sessionId, "shared execution")
    let liveTaskId = ""
    startSessionCommandDispatcher(async (request) => {
      const body = await request.json() as { requestId: string }
      const owner = randomUUID()
      await acquireSessionCommand(body.requestId, owner)
      const task = taskScheduler.enqueue({
        requestId: body.requestId,
        sessionId,
        agentId: "main-agent",
        priority: 8,
        type: "chat",
        message: "shared execution",
        workingDir: ".",
        onCancel: () => undefined,
      })
      liveTaskId = task.id
      SessionCommandRepo.bindTask(body.requestId, owner, task.id)
      return Response.json({ accepted: true, duplicate: true })
    })

    await waitFor(() => SessionCommandRepo.get(command.requestId)?.state === "accepted")
    await Bun.sleep(350)
    expect(SessionCommandRepo.get(command.requestId)?.state).toBe("accepted")
    taskScheduler.cancel(liveTaskId)
    taskScheduler.confirmWorkerExit(liveTaskId, "test cleanup")
  })
})

function trackedSession(): string {
  const sessionId = `session-command-test-${randomUUID()}`
  SessionRepo.create({
    id: sessionId,
    title: "session command test",
    agent_id: "main-agent",
    project_path: ".",
  })
  sessions.add(sessionId)
  return sessionId
}

function enqueue(sessionId: string, message: string) {
  const requestId = randomUUID()
  const payload = JSON.stringify({ sessionId, requestId, message })
  return SessionCommandRepo.enqueue({ sessionId, requestId, payload }).command
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(20)
  }
}
