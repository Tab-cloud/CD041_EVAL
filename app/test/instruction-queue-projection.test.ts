import { describe, expect, test } from "bun:test"
import type { QueuedInstruction } from "../src/store"
import {
  currentAdmissionInstructionForSession,
  isWaitingInstruction,
  waitingInstructionsForSession,
} from "../src/instruction-queue-projection"

function instruction(
  requestId: string,
  serverState: QueuedInstruction["serverState"],
  sessionId = "session-a",
): QueuedInstruction {
  return {
    id: requestId,
    requestId,
    sessionId,
    text: requestId,
    attachments: [],
    scope: "auto-edit",
    effort: "on",
    modelId: null,
    workingDir: null,
    serverState,
    createdAt: 1,
  }
}

describe("instruction queue projection", () => {
  test("only commands that have not started appear under Next", () => {
    expect(isWaitingInstruction(instruction("local", "local"))).toBe(true)
    expect(isWaitingInstruction(instruction("pending", "pending"))).toBe(true)
    expect(isWaitingInstruction(instruction("processing", "processing"))).toBe(false)
    expect(isWaitingInstruction(instruction("accepted", "accepted"))).toBe(false)
  })

  test("filters by session without duplicating the current command", () => {
    const projected = waitingInstructionsForSession([
      instruction("current-processing", "processing"),
      instruction("current-running", "accepted"),
      instruction("active-before-state-refresh", "pending"),
      instruction("next-local", "local"),
      instruction("next-pending", "pending"),
      instruction("other-session", "pending", "session-b"),
    ], "session-a", "active-before-state-refresh")

    expect(projected.map((item) => item.requestId)).toEqual(["next-local", "next-pending"])
  })

  test("does not label the first admission as queued when no predecessor exists", () => {
    const instructions = [
      instruction("starting-local", "local"),
      instruction("actual-successor", "pending"),
    ]
    const projected = waitingInstructionsForSession(instructions, "session-a")

    expect(projected.map((item) => item.requestId)).toEqual(["actual-successor"])
    expect(currentAdmissionInstructionForSession(instructions, "session-a")?.requestId)
      .toBe("starting-local")
  })

  test("keeps pending successors visible when the durable head has started", () => {
    const projected = waitingInstructionsForSession([
      instruction("current-processing", "processing"),
      instruction("next-pending", "pending"),
    ], "session-a")

    expect(projected.map((item) => item.requestId)).toEqual(["next-pending"])
  })
})
