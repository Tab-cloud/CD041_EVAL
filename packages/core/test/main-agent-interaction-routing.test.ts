import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { brokerSubAgentInteraction } from "../src/runtime/main-agent-interaction-routing.ts"
import { mainAgentInteractionInbox } from "../src/runtime/main-agent-interaction-inbox.ts"
import { userQuestionManager } from "../src/runtime/user-question.ts"
import { TaskRunRepo, type TaskRunView } from "../src/store/task-run.ts"

const sessions = new Set<string>()

afterEach(() => {
  for (const sessionId of sessions) {
    mainAgentInteractionInbox.deleteBySession(sessionId)
    TaskRunRepo.deleteBySession(sessionId)
  }
  sessions.clear()
})

test("child question is re-owned, sanitized and resolved by the root Agent", async () => {
  const sessionId = trackedSession()
  const rootRunId = `task-root-${randomUUID()}`
  const childRunId = `task-child-${randomUUID()}`
  createTask(sessionId, rootRunId)
  createTask(sessionId, childRunId, rootRunId)
  const published: Array<{ type: string; payload: any }> = []

  const resolution = brokerSubAgentInteraction({
    rootRunId,
    sessionId,
    request: {
      type: "question-request",
      payload: {
        question: {
          id: "child-question",
          sessionId,
          runId: childRunId,
          toolCallId: "child-tool",
          question: `子 Agent ${childRunId} 请求选择`,
          options: ["继续", "取消"],
          allowCustom: false,
          createdAt: Date.now(),
        },
      },
      requiresMainAgentReview: true,
      visibility: "internal",
    },
    publish: (type, payload) => published.push({ type, payload }),
  })

  const publicRequest = await waitForQuestion(sessionId)
  expect(publicRequest.runId).toBe(rootRunId)
  expect(publicRequest.question).not.toContain(childRunId)
  expect(publicRequest.question).not.toContain("子 Agent")
  expect(publicRequest.allowCustom).toBe(false)
  userQuestionManager.respond(publicRequest.id, "继续")

  expect(await resolution).toEqual({ status: "answered", answer: "继续" })
  expect(published.map((event) => event.type)).toEqual([
    "question-request",
    "question-resolved",
  ])
  expect(mainAgentInteractionInbox.list(rootRunId)).toMatchObject([
    {
      sourceId: "child-question",
      childRunId,
      rootRunId,
      state: "resolved",
    },
  ])
})

function trackedSession(): string {
  const sessionId = `interaction-test-${randomUUID()}`
  sessions.add(sessionId)
  return sessionId
}

function createTask(sessionId: string, id: string, parentRunId?: string): void {
  const now = Date.now()
  const task: TaskRunView = {
    id,
    parentRunId,
    sessionId,
    agentId: parentRunId ? "worker" : "main-agent",
    priority: 8,
    status: "running",
    message: "interaction test",
    workingDir: process.cwd(),
    type: "chat",
    createdAt: now,
    startedAt: now,
  }
  TaskRunRepo.create(task)
}

async function waitForQuestion(sessionId: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const request = userQuestionManager.list(sessionId)[0]
    if (request) return request
    await Bun.sleep(10)
  }
  throw new Error("root question was not published")
}
