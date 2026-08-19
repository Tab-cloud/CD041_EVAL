import { describe, expect, test } from "bun:test"
import { projectInstructionUserMessages } from "../src/instruction-message-projection"
import type { QueuedInstruction } from "../src/store"
import type { ChatMessage } from "../src/types"

function instruction(requestId: string, text = requestId, createdAt = 1): QueuedInstruction {
  return {
    id: requestId,
    requestId,
    sessionId: "session-a",
    text,
    attachments: [],
    scope: "auto-edit",
    effort: "on",
    modelId: null,
    workingDir: null,
    serverState: "local",
    createdAt,
  }
}

describe("instruction user message projection", () => {
  test("the first local instruction is visible before a server task exists", () => {
    const projected = projectInstructionUserMessages([], [instruction("request-hi", "hi")], "session-a")

    expect(projected).toEqual([expect.objectContaining({
      role: "user",
      requestId: "request-hi",
      content: "hi",
    })])
  })

  test("server history and optimistic projection keep one user bubble per request", () => {
    const history: ChatMessage[] = [{
      role: "user",
      requestId: "request-hi",
      content: "hi",
      timestamp: 2,
    }]

    expect(projectInstructionUserMessages(history, [instruction("request-hi", "hi")], "session-a"))
      .toBe(history)
  })

  test("projects queued successors in send order without leaking another session", () => {
    const other = { ...instruction("other"), sessionId: "session-b" }
    const projected = projectInstructionUserMessages([], [
      instruction("second", "second", 2),
      other,
      instruction("first", "first", 1),
    ], "session-a")

    expect(projected.map((message) => message.requestId)).toEqual(["first", "second"])
  })

  test("manual compaction remains an internal turn", () => {
    expect(projectInstructionUserMessages([], [instruction("compact", "/compact")], "session-a"))
      .toEqual([])
  })
})
