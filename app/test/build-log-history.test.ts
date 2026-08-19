import { expect, test } from "bun:test"
import { projectBuildLogEvents } from "../src/build-log-events"
import { appReducer, createInitialState } from "../src/store"

test("projectBuildLogEvents keeps only build output with durable ids", () => {
  const logs = projectBuildLogEvents([
    {
      runId: "run-1", sessionId: "session-1", seq: 3, type: "tool-stream",
      payload: { target: "build", text: "CC main.c", type: "stdout" }, createdAt: 123,
    },
    {
      runId: "run-1", sessionId: "session-1", seq: 4, type: "tool-stream",
      payload: { target: "terminal", text: "pwd", type: "stdout" }, createdAt: 124,
    },
  ])
  expect(logs).toEqual([{ id: "run-1:3", text: "CC main.c", type: "info", timestamp: 123 }])
})

test("build logs are isolated by session and restored without duplicates", () => {
  let state = createInitialState()
  state = appReducer(state, { type: "SET_ACTIVE_SESSION", sessionId: "session-a" })
  state = appReducer(state, {
    type: "ADD_LOG", target: "build", sessionId: "session-a",
    line: { id: "run-a:1", text: "CC a.c", type: "info", timestamp: 1 },
  })
  state = appReducer(state, { type: "SET_ACTIVE_SESSION", sessionId: "session-b" })
  expect(state.buildOutput).toEqual([])
  state = appReducer(state, {
    type: "SET_BUILD_LOGS", sessionId: "session-a",
    logs: [{ id: "run-a:1", text: "CC a.c", type: "info", timestamp: 1 }],
  })
  expect(state.buildOutput).toEqual([])
  state = appReducer(state, { type: "SET_ACTIVE_SESSION", sessionId: "session-a" })
  expect(state.buildOutput.map((line) => line.text)).toEqual(["CC a.c"])
})
