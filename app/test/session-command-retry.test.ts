import { describe, expect, test } from "bun:test"
import {
  selectLocalInstructionsForSubmission,
  sessionCommandRetryDelay,
} from "../src/hooks/useSessionCommandQueue"
import { isRetryableSessionCommandError, SessionCommandSubmissionError } from "../src/session-commands"
import type { QueuedInstruction } from "../src/store"

function localInstruction(requestId: string, sessionId: string, retryAt?: number): QueuedInstruction {
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
    createdAt: Date.now(),
    serverState: "local",
    submissionRetryAt: retryAt,
  }
}

describe("session command retry", () => {
  test("backs off repeated local transport failures without giving up", () => {
    expect([1, 2, 3, 4, 5, 6].map(sessionCommandRetryDelay))
      .toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000])
  })

  test("does not retry a request rejected for its size", () => {
    expect(isRetryableSessionCommandError(
      new SessionCommandSubmissionError("HTTP 413", false, 413),
    )).toBe(false)
  })

  test("keeps FIFO within a session while allowing another session to submit", () => {
    const now = 10_000
    const queue = [
      localInstruction("a-retrying", "session-a", now + 5_000),
      localInstruction("a-next", "session-a"),
      localInstruction("b-ready", "session-b"),
    ]

    expect(selectLocalInstructionsForSubmission(queue, new Set(), now).map((item) => item.requestId))
      .toEqual(["b-ready"])
  })

  test("never submits two local commands from the same session concurrently", () => {
    const queue = [
      localInstruction("a-head", "session-a"),
      localInstruction("a-next", "session-a"),
      localInstruction("b-head", "session-b"),
    ]

    expect(selectLocalInstructionsForSubmission(queue, new Set(["a-head"]), Date.now())
      .map((item) => item.requestId)).toEqual(["b-head"])
  })
})
