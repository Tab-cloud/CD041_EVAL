import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  projectPublicRunEvent,
  projectPublicRunEventRecord,
  PUBLIC_RUN_EVENT_PROJECTION_VERSION,
} from "../src/runtime/public-run-event.ts"
import { createRunEventEmitter } from "../src/runtime/server-chat-events.ts"
import { commandSubscriptionResponse } from "../src/runtime/session-command-subscription.ts"
import { SESSION_COMMAND_PROCESS_EPOCH } from "../src/runtime/session-command-queue.ts"
import { RunEventRepo } from "../src/store/run-event.ts"
import { SessionCommandRepo } from "../src/store/session-command.ts"
import { SessionRepo } from "../src/store/repository.ts"

const sessionIds = new Set<string>()
const runIds = new Set<string>()

afterEach(() => {
  for (const runId of runIds) RunEventRepo.deleteByRun(runId)
  for (const sessionId of sessionIds) {
    SessionCommandRepo.deleteBySession(sessionId)
    SessionRepo.delete(sessionId)
  }
  runIds.clear()
  sessionIds.clear()
})

describe("blocked event durable replay", () => {
  test("execution-blocked projection is idempotent", () => {
    const first = projectPublicRunEvent("execution-blocked", {
      reason: "HTTP 429: 已达到 Token Plan 用量上限 (2056)",
    })
    expect(first).not.toBeNull()
    const second = projectPublicRunEvent(first!.type, first!.payload)

    expect(second).toEqual(first)
    expect(second?.payload).toMatchObject({
      kind: "problem",
      code: "model-quota-exhausted",
      message: "所选模型的配额已耗尽。请切换模型或补充额度后重试。",
      retryable: true,
    })
  })

  test("current-version durable events replay without a second lossy projection", async () => {
    const sessionId = createSession()
    const runId = `blocked-run-${randomUUID()}`
    const requestId = `blocked-request-${randomUUID()}`
    runIds.add(runId)
    SessionCommandRepo.enqueue({
      requestId,
      sessionId,
      payload: JSON.stringify({ sessionId, requestId, message: "解析 PDF" }),
    })

    const chunks: Uint8Array[] = []
    const emit = createRunEventEmitter({
      controller: { enqueue: (chunk) => chunks.push(chunk) },
      runId,
      sessionId,
      requestId,
      agentId: "main-agent",
      isSseAborted: () => false,
    })
    emit("execution-blocked", {
      reason: "HTTP 429: 已达到 Token Plan 用量上限：请补充用量。 (2056)",
    })
    emit("done", {
      sessionId,
      taskId: runId,
      status: "blocked",
      error: "模型配额已耗尽，需等待额度恢复",
    })
    expect(SessionCommandRepo.tryClaim(
      requestId,
      "blocked-owner",
      SESSION_COMMAND_PROCESS_EPOCH,
    )?.state).toBe("processing")
    expect(SessionCommandRepo.bindTask(requestId, "blocked-owner", runId)?.state).toBe("accepted")
    SessionCommandRepo.finish(requestId, "blocked", "模型配额已耗尽，需等待额度恢复")
    const stored = RunEventRepo.listAfter(runId)
    expect(stored).toHaveLength(2)
    expect(stored.every((event) =>
      event.projectionVersion === PUBLIC_RUN_EVENT_PROJECTION_VERSION)).toBe(true)
    expect(projectPublicRunEventRecord(stored[0])?.payload).toEqual(stored[0]?.payload)

    const response = commandSubscriptionResponse(requestId, sessionId, {})
    const replay = await response.text()
    expect(replay).toContain("event: execution-blocked")
    expect(replay).toContain('"code":"model-quota-exhausted"')
    expect(replay).toContain("所选模型的配额已耗尽。请切换模型或补充额度后重试。")
    expect(replay).not.toContain("任务正在等待外部条件")
    expect(replay).not.toContain("Token Plan")
    expect(replay).not.toContain("2056")
  })

  test("blocked is a terminal command state and releases the FIFO lane", () => {
    const sessionId = createSession()
    const first = SessionCommandRepo.enqueue({
      requestId: randomUUID(),
      sessionId,
      payload: JSON.stringify({ message: "first" }),
    }).command
    const second = SessionCommandRepo.enqueue({
      requestId: randomUUID(),
      sessionId,
      payload: JSON.stringify({ message: "second" }),
    }).command

    expect(SessionCommandRepo.finish(
      first.requestId,
      "blocked",
      "模型配额已耗尽",
    )?.state).toBe("blocked")
    expect(SessionCommandRepo.listPending(sessionId).map((item) => item.requestId))
      .toEqual([second.requestId])
    expect(SessionCommandRepo.tryClaim(
      second.requestId,
      "next-owner",
      SESSION_COMMAND_PROCESS_EPOCH,
    )?.state).toBe("processing")
  })
})

function createSession(): string {
  const sessionId = `blocked-session-${randomUUID()}`
  SessionRepo.create({
    id: sessionId,
    title: "blocked replay test",
    agent_id: "main-agent",
    project_path: ".",
  })
  sessionIds.add(sessionId)
  return sessionId
}
