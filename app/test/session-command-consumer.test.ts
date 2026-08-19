import { describe, expect, test } from "bun:test"
import type { QueuedInstruction, SessionRunProjection } from "../src/store"
import { hasOutstandingSessionInstruction } from "../src/instruction-queue"
import {
  SessionCommandConsumerLedger,
  startDurableSessionInstructionSubscription,
} from "../src/session-command-consumer"

describe("session command consumer ledger", () => {
  test("one renderer owns at most one active transport per session", () => {
    const ledger = new SessionCommandConsumerLedger()

    expect(ledger.claim("session-1", "request-1")).toBe(true)
    expect(ledger.claim("session-1", "request-1")).toBe(false)
    expect(ledger.claim("session-1", "request-2")).toBe(false)
    expect(ledger.activeRequest("session-1")).toBe("request-1")
    expect(ledger.release("session-1", "request-2")).toBe(false)
    expect(ledger.release("session-1", "request-1")).toBe(true)
    expect(ledger.activeRequest("session-1")).toBeUndefined()
  })

  test("stream interruption and renderer restart both reattach the durable FIFO head", async () => {
    const current = instruction("current", "accepted", 1)
    const next = instruction("next", "pending", 2)
    const queue = [next, current]
    const run: SessionRunProjection = {
      sessionId: "session-1",
      requestId: "current",
      taskId: "task-current",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
    }
    const beginRequestCalls: string[] = []
    let releaseTransport!: () => void
    const attach = (ledger: SessionCommandConsumerLedger) =>
      startDurableSessionInstructionSubscription({
        ledger,
        queue,
        sessionId: "session-1",
        run,
        hydrated: true,
        subscribe: async (candidate) => {
          // Production useChat calls send() here; send() enters beginRequest.
          beginRequestCalls.push(candidate.requestId)
          await new Promise<void>((resolve) => { releaseTransport = resolve })
        },
      })

    const ledger = new SessionCommandConsumerLedger()
    expect(attach(ledger)?.requestId).toBe("current")
    expect(attach(ledger)).toBeUndefined()
    expect(beginRequestCalls).toEqual(["current"])

    // The SSE transport ends, but the server still projects current as
    // accepted/running. Reattachment must target current, never next.
    releaseTransport()
    await flushMicrotasks()
    expect(attach(ledger)?.requestId).toBe("current")
    expect(beginRequestCalls).toEqual(["current", "current"])
    releaseTransport()
    await flushMicrotasks()

    // A renderer restart has an empty process-local lease ledger. Durable
    // command/run state still selects the same FIFO head.
    const restarted = new SessionCommandConsumerLedger()
    expect(attach(restarted)?.requestId).toBe("current")
    expect(beginRequestCalls.at(-1)).toBe("current")
    releaseTransport()
    await flushMicrotasks()

    // Only a server projection in which the predecessor is terminal/absent
    // allows the successor subscription to begin.
    expect(startDurableSessionInstructionSubscription({
      ledger: restarted,
      queue: [next],
      sessionId: "session-1",
      hydrated: true,
      subscribe: async (candidate) => { beginRequestCalls.push(candidate.requestId) },
    })?.requestId).toBe("next")
    await flushMicrotasks()
    expect(beginRequestCalls.at(-1)).toBe("next")
  })

  test("an active run missing from a partial command projection fails closed", () => {
    const beginRequestCalls: string[] = []
    const ledger = new SessionCommandConsumerLedger()
    expect(startDurableSessionInstructionSubscription({
      ledger,
      queue: [instruction("next", "pending", 2)],
      sessionId: "session-1",
      run: {
        sessionId: "session-1",
        requestId: "current",
        taskId: "task-current",
        status: "waiting-delegation",
        startedAt: 1,
        updatedAt: 2,
      },
      hydrated: true,
      subscribe: async (candidate) => { beginRequestCalls.push(candidate.requestId) },
    })).toBeUndefined()
    expect(beginRequestCalls).toEqual([])
  })

  test("useChat admission waits for the first authoritative command hydration", () => {
    const beginRequestCalls: string[] = []
    expect(startDurableSessionInstructionSubscription({
      ledger: new SessionCommandConsumerLedger(),
      queue: [instruction("restored-local-cache", "accepted", 1)],
      sessionId: "session-1",
      hydrated: false,
      subscribe: async (candidate) => { beginRequestCalls.push(candidate.requestId) },
    })).toBeUndefined()
    expect(beginRequestCalls).toEqual([])
  })

  test("a detached local stream cannot bypass an outstanding durable command", () => {
    const current = instruction("current", "accepted", 1)
    expect(hasOutstandingSessionInstruction(
      [current],
      "session-1",
    )).toBe(true)
    expect(hasOutstandingSessionInstruction(
      [],
      "session-1",
      {
        sessionId: "session-1",
        requestId: "current",
        taskId: "task-current",
        status: "running",
        startedAt: 1,
        updatedAt: 2,
      },
    )).toBe(true)
  })
})

function instruction(
  requestId: string,
  serverState: QueuedInstruction["serverState"],
  sessionSeq: number,
): QueuedInstruction {
  return {
    id: requestId,
    requestId,
    sessionId: "session-1",
    text: requestId,
    attachments: [],
    scope: "auto-edit",
    effort: "on",
    modelId: null,
    workingDir: null,
    serverState,
    sessionSeq,
    createdAt: sessionSeq,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
