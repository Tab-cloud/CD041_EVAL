import { describe, expect, test } from "bun:test"
import {
  SessionLifecycleManager,
  type SessionLifecycleDependencies,
} from "../src/runtime/session-lifecycle.ts"

describe("session aggregate lifecycle", () => {
  test("running deletion remains non-terminal until Worker exit acknowledgement", async () => {
    const state = fakeState()
    state.tasks.set("root", "running")
    let cleanupCalls = 0
    let manager!: SessionLifecycleManager
    const dependencies = fakeDependencies(state, {
      cancelTask: (id) => {
        expect(manager.isTerminating("session-running")).toBe(true)
        state.tasks.set(id, "cancelling")
      },
    })
    manager = new SessionLifecycleManager(dependencies)

    const pending = await manager.terminate({
      sessionId: "session-running",
      mode: "delete",
      waitTimeoutMs: 0,
      cleanup: () => { cleanupCalls++ },
    })

    expect(pending.status).toBe("pending")
    expect(cleanupCalls).toBe(0)
    expect(manager.getState("session-running")).toMatchObject({
      phase: "waiting-exit",
      pending: { taskIds: ["root"] },
    })

    // This transition represents TaskScheduler.confirmWorkerExit. Only a
    // subsequent lifecycle pass may now execute durable cleanup.
    state.tasks.set("root", "cancelled")
    const completed = await manager.terminate({
      sessionId: "session-running",
      mode: "delete",
      cleanup: () => { cleanupCalls++; return "deleted" },
    })

    expect(completed).toEqual({ status: "completed", value: "deleted" })
    expect(cleanupCalls).toBe(1)
    expect(manager.isTerminating("session-running")).toBe(false)
  })

  test("all execution surfaces are closed before one centralized cleanup", async () => {
    const state = fakeState()
    state.tasks.set("root", "running")
    state.tasks.set("child", "safety-quarantine")
    state.workflows.set("workflow", "running")
    state.commands.add("command")
    state.questions.add("question")
    state.approvals.add("approval")
    state.schedulesEnabled = true
    const events: string[] = []
    const manager = new SessionLifecycleManager(fakeDependencies(state, {
      cancelTask: (id) => {
        events.push(`task:${id}`)
        state.tasks.set(id, "cancelled")
      },
      cancelWorkflow: (id) => {
        events.push(`workflow:${id}`)
        state.workflows.set(id, "cancelled")
      },
      cancelCommand: (id) => {
        events.push(`command:${id}`)
        state.commands.delete(id)
      },
      cancelQuestion: (id) => {
        events.push(`question:${id}`)
        state.questions.delete(id)
      },
      cancelApproval: (id) => {
        events.push(`approval:${id}`)
        state.approvals.delete(id)
      },
      disableSchedules: () => {
        events.push("schedules")
        state.schedulesEnabled = false
      },
    }))

    const result = await manager.terminate({
      sessionId: "session-all",
      mode: "clear",
      cleanup: () => {
        events.push("cleanup")
        expect(state.schedulesEnabled).toBe(false)
        expect([...state.tasks.values()].every((status) => status === "cancelled")).toBe(true)
        expect([...state.workflows.values()].every((status) => status === "cancelled")).toBe(true)
        expect(state.commands.size + state.questions.size + state.approvals.size).toBe(0)
        return { success: true }
      },
    })

    expect(result).toEqual({ status: "completed", value: { success: true } })
    expect(events.at(-1)).toBe("cleanup")
    expect(events).toContain("task:root")
    expect(events).toContain("task:child")
    expect(events).toContain("workflow:workflow")
  })

  test("cleanup failure keeps the session fenced and allows a safe retry", async () => {
    const state = fakeState()
    const manager = new SessionLifecycleManager(fakeDependencies(state))

    const failed = await manager.terminate({
      sessionId: "session-failure",
      mode: "clear",
      cleanup: () => { throw new Error("transaction rolled back") },
    })

    expect(failed.status).toBe("failed")
    expect(manager.getState("session-failure")).toMatchObject({
      phase: "cleanup-failed",
      error: "transaction rolled back",
    })
    expect(manager.isTerminating("session-failure")).toBe(true)

    const retry = await manager.terminate({
      sessionId: "session-failure",
      mode: "clear",
      cleanup: () => "cleared",
    })
    expect(retry).toEqual({ status: "completed", value: "cleared" })
    expect(manager.isTerminating("session-failure")).toBe(false)
  })
})

type FakeState = {
  tasks: Map<string, string>
  workflows: Map<string, string>
  commands: Set<string>
  questions: Set<string>
  approvals: Set<string>
  schedulesEnabled: boolean
}

type FakeOverrides = {
  cancelTask?: (id: string) => void
  cancelWorkflow?: (id: string) => void
  cancelCommand?: (id: string) => void
  cancelQuestion?: (id: string) => void
  cancelApproval?: (id: string) => void
  disableSchedules?: () => void
}

function fakeState(): FakeState {
  return {
    tasks: new Map(),
    workflows: new Map(),
    commands: new Set(),
    questions: new Set(),
    approvals: new Set(),
    schedulesEnabled: false,
  }
}

function fakeDependencies(
  state: FakeState,
  overrides: FakeOverrides = {},
): SessionLifecycleDependencies {
  return {
    tasks: {
      list: () => [...state.tasks].map(([id, status]) => ({ id, status })),
      cancel: (id) => {
        overrides.cancelTask?.(id)
        if (!overrides.cancelTask) state.tasks.set(id, "cancelled")
        return true
      },
    },
    workflows: {
      list: () => [...state.workflows].map(([id, status]) => ({ id, status })),
      cancel: (id) => {
        overrides.cancelWorkflow?.(id)
        if (!overrides.cancelWorkflow) state.workflows.set(id, "cancelled")
      },
      disableSchedules: () => {
        overrides.disableSchedules?.()
        if (!overrides.disableSchedules) state.schedulesEnabled = false
      },
    },
    commands: {
      listPending: () => [...state.commands].map((requestId) => ({ requestId })),
      cancel: (id) => {
        overrides.cancelCommand?.(id)
        if (!overrides.cancelCommand) state.commands.delete(id)
      },
    },
    questions: {
      list: () => [...state.questions].map((id) => ({ id })),
      cancel: (id) => {
        overrides.cancelQuestion?.(id)
        if (!overrides.cancelQuestion) state.questions.delete(id)
      },
    },
    approvals: {
      list: () => [...state.approvals].map((id) => ({ id })),
      cancel: (id) => {
        overrides.cancelApproval?.(id)
        if (!overrides.cancelApproval) state.approvals.delete(id)
      },
    },
  }
}
