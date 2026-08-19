import { describe, expect, test } from "bun:test"
import {
  detachTerminalSubscription,
  shouldRestoreTerminalTask,
} from "../src/terminal-subscription-recovery"

describe("terminal subscription recovery", () => {
  test("aborts only the matching live task stream", () => {
    const abort = new AbortController()
    const matched = detachTerminalSubscription({
      sessionId: "session-a",
      taskId: "task-a",
      activeTasksBySession: new Map([["session-a", "task-a"]]),
      abortsBySession: new Map([["session-a", abort]]),
    })

    expect(matched).toBe(true)
    expect(abort.signal.aborted).toBe(true)
  })

  test("does not detach an older terminal task from a newer live stream", () => {
    const abort = new AbortController()
    const matched = detachTerminalSubscription({
      sessionId: "session-a",
      taskId: "task-old",
      activeTasksBySession: new Map([["session-a", "task-new"]]),
      abortsBySession: new Map([["session-a", abort]]),
    })

    expect(matched).toBe(false)
    expect(abort.signal.aborted).toBe(false)
  })

  test("is idempotent after the matching stream is detached", () => {
    const abort = new AbortController()
    abort.abort()

    expect(detachTerminalSubscription({
      sessionId: "session-a",
      taskId: "task-a",
      activeTasksBySession: new Map([["session-a", "task-a"]]),
      abortsBySession: new Map([["session-a", abort]]),
    })).toBe(false)
  })

  test("restores only the terminal task that owns the active session run", () => {
    expect(shouldRestoreTerminalTask({
      activeSessionId: "session-a",
      activeRunTaskId: "task-a",
      terminalSessionId: "session-a",
      terminalTaskId: "task-a",
    })).toBe(true)

    expect(shouldRestoreTerminalTask({
      activeSessionId: "session-a",
      activeRunTaskId: "task-new",
      terminalSessionId: "session-a",
      terminalTaskId: "task-old",
    })).toBe(false)

    expect(shouldRestoreTerminalTask({
      activeSessionId: "session-b",
      activeRunTaskId: "task-a",
      terminalSessionId: "session-a",
      terminalTaskId: "task-a",
    })).toBe(false)
  })
})
