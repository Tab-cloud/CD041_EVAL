import { beforeEach, describe, expect, test } from "bun:test"
import {
  loadOfficeAvatarRuntime,
  resetOfficeAvatarRuntimeForTests,
  saveOfficeAvatarRuntime,
} from "../src/office/office-avatar-runtime"
import { getOfficeSnapshot } from "../src/office/office-events"
import { publishTaskActivity } from "../src/components/agentOfficeHelpers"

describe("persistent office runtime", () => {
  beforeEach(() => resetOfficeAvatarRuntimeForTests())

  test("restores the last movement state for the same session and task", () => {
    saveOfficeAvatarRuntime({
      sessionId: "session-a",
      runId: "run-a",
      position: { x: 42.5, y: 63.25 },
      target: { x: 70, y: 58 },
      direction: "right",
      gaitStep: 1,
      phase: "walking",
      traveling: true,
      updatedAt: Date.now(),
    })

    expect(loadOfficeAvatarRuntime("session-a", "run-a")).toMatchObject({
      position: { x: 42.5, y: 63.25 },
      target: { x: 70, y: 58 },
      direction: "right",
      gaitStep: 1,
      phase: "walking",
      traveling: true,
    })
  })

  test("isolates identical run IDs across conversations", () => {
    const base = {
      runId: "shared-run",
      target: { x: 10, y: 10 },
      direction: "front" as const,
      gaitStep: 0 as const,
      phase: "standing" as const,
      traveling: false,
      updatedAt: Date.now(),
    }
    saveOfficeAvatarRuntime({ ...base, sessionId: "session-a", position: { x: 12, y: 30 } })
    saveOfficeAvatarRuntime({ ...base, sessionId: "session-b", position: { x: 72, y: 80 } })

    expect(loadOfficeAvatarRuntime("session-a", "shared-run")?.position.x).toBe(12)
    expect(loadOfficeAvatarRuntime("session-b", "shared-run")?.position.x).toBe(72)
  })

  test("binds a backend task to its actual employee identity", () => {
    const runId = `binding-${Date.now()}`
    publishTaskActivity({
      id: runId,
      sessionId: "binding-session",
      agentId: "firmware-engineer",
      status: "running",
      message: "正在调试固件",
      startedAt: Date.now(),
    }, [{
      id: "firmware-engineer",
      name: "固件工程师",
      description: "",
      mode: "subagent",
      color: "#22c55e",
      tools: [],
      source: "builtin",
    }])

    expect(getOfficeSnapshot().agents.find((agent) => agent.runId === runId)).toMatchObject({
      sessionId: "binding-session",
      agentId: "firmware-engineer",
      agentName: "固件工程师",
      state: "executing",
    })
  })
})
