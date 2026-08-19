import { describe, expect, test } from "bun:test"
import { submitRunGuidance } from "../src/session-commands"
import { appReducer, type AppState } from "../src/store"

describe("current-run guidance client", () => {
  test("submits to the guidance endpoint without changing the active permission scope", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const guidance = await submitRunGuidance({
      requestId: "guidance-1",
      taskId: "task-123",
      sessionId: "session-123",
      text: "fix the PPTX in this task",
      attachments: [],
      workingDir: "D:/workspace",
    }, async (path, init) => {
      requests.push({
        path,
        body: JSON.parse(String(init?.body ?? "{}")),
      })
      return Response.json({
        guidance: {
          requestId: "guidance-1",
          taskId: "task-123",
          sessionId: "session-123",
          message: "fix the PPTX in this task",
          state: "pending",
          createdAt: 10,
          attachments: [],
        },
      }, { status: 201 })
    })

    expect(guidance.state).toBe("pending")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({
      path: "/api/tasks/guidance",
      body: {
        requestId: "guidance-1",
        taskId: "task-123",
        sessionId: "session-123",
        message: "fix the PPTX in this task",
        attachments: [],
      },
    })
    expect(requests[0]?.body).not.toHaveProperty("scope")
  })

  test("places the steer before the active assistant response and remains idempotent", () => {
    const original = {
      role: "user" as const,
      requestId: "root-request",
      content: "create a PPTX",
      timestamp: 1,
    }
    const assistant = {
      role: "assistant" as const,
      requestId: "root-request",
      content: "working",
      timestamp: 2,
    }
    let state = { messages: [original, assistant] } as AppState
    const action = {
      type: "ADD_GUIDANCE_MESSAGE" as const,
      activeRequestId: "root-request",
      message: {
        role: "user" as const,
        requestId: "guidance-request",
        content: "the PPTX cannot open",
        timestamp: 3,
      },
    }

    state = appReducer(state, action)
    state = appReducer(state, action)

    expect(state.messages.map((message) => [message.role, message.requestId, message.content]))
      .toEqual([
        ["user", "root-request", "create a PPTX"],
        ["user", "guidance-request", "the PPTX cannot open"],
        ["assistant", "root-request", "working"],
      ])
  })
})
