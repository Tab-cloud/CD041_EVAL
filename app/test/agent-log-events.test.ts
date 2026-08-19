import { describe, expect, test } from "bun:test"
import { projectAgentLogEvents } from "../src/agent-log-events"

describe("agent log event projection", () => {
  test("does not duplicate one terminal model error through task status", () => {
    const message = "任务执行遇到问题，主 Agent 已保留诊断信息。"
    const logs = projectAgentLogEvents([
      { eventId: "event-1", seq: 1, type: "task-status", payload: { status: "failed", problem: { message } }, createdAt: 1 },
      { eventId: "event-2", seq: 2, type: "error", payload: { message }, createdAt: 2 },
      { eventId: "event-3", seq: 3, type: "done", payload: { status: "failed", problem: { message } }, createdAt: 3 },
    ])

    expect(logs.map((line) => line.text)).toEqual([message])
  })
})
