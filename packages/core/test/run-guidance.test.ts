import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { AgentRegistry } from "../src/agent/registry.ts"
import { ModelRouter } from "../src/model-router/index.ts"
import { AgentLoop } from "../src/runtime/agent-loop.ts"
import { ExecutionController } from "../src/runtime/agent-loop-control.ts"
import { handleTaskRoutes } from "../src/runtime/server-tasks.ts"
import { MessageRepo, SessionRepo } from "../src/store/repository.ts"
import { RunGuidanceRepo } from "../src/store/run-guidance.ts"
import { TaskRunRepo, type TaskRunView } from "../src/store/task-run.ts"
import { ToolRegistry } from "../src/tool/registry.ts"

const sessions = new Set<string>()

afterEach(() => {
  for (const sessionId of sessions) SessionRepo.delete(sessionId)
  sessions.clear()
})

describe("same-run user guidance", () => {
  test("admits idempotent guidance into the active root without creating a successor command", async () => {
    const { sessionId, task } = activeTask()
    const requestId = randomUUID()
    const body = {
      requestId,
      taskId: task.id,
      sessionId,
      message: "PPTX 文件仍然无法正常打开，请在当前任务中修复并验证",
      attachments: [{
        name: "failure.txt",
        size: 12,
        mime: "text/plain",
        kind: "text",
        content: "open failed",
      }],
    }

    const first = await submit(body)
    const duplicate = await submit(body)
    expect(first.status).toBe(201)
    expect(duplicate.status).toBe(200)
    expect((await first.json()).guidance).toMatchObject({
      requestId,
      taskId: task.id,
      state: "pending",
    })
    expect(RunGuidanceRepo.list(task.id)).toHaveLength(1)
    expect(MessageRepo.getBySession(sessionId).filter((message) => message.request_id === requestId))
      .toHaveLength(1)

    const consumed = RunGuidanceRepo.consumePending(task.id)
    expect(consumed).toHaveLength(1)
    expect(consumed[0]).toMatchObject({
      requestId,
      state: "applied",
      attachments: [{ name: "failure.txt", kind: "text", content: "open failed" }],
    })
    expect(RunGuidanceRepo.consumePending(task.id)).toEqual([])
  })

  test("rejects new guidance after the task has reached a terminal state", async () => {
    const { sessionId, task } = activeTask()
    TaskRunRepo.update({ ...task, status: "completed", completedAt: Date.now() })
    const requestId = randomUUID()

    const response = await submit({
      requestId,
      taskId: task.id,
      sessionId,
      message: "late guidance",
    })

    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain("已经结束")
    expect(RunGuidanceRepo.list(task.id)).toEqual([])
    expect(MessageRepo.getBySession(sessionId).some((message) => message.request_id === requestId))
      .toBe(false)
  })

  test("guidance re-opens finalization as runtime-owned work without changing authorization", () => {
    const controller = new ExecutionController(5, 10, 60_000, 3, {
      initialTodos: [{ content: "initial", status: "in_progress", priority: "high" }],
    })
    expect(controller.onModelYield()).toBe("complete")

    const snapshot = controller.acceptUserGuidance(["repair the generated PPTX"])

    expect(controller.currentRound().phase).toBe("execution")
    expect(snapshot.state).toBe("running")
    expect(snapshot.todos).toContainEqual(expect.objectContaining({
      content: "repair the generated PPTX",
      status: "in_progress",
      priority: "high",
    }))
    expect(snapshot.runtimeTodoContents).toContain("repair the generated PPTX")
  })

  test("agent loop absorbs late guidance before completing the same run", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-run-guidance-loop-"))
    const sessionId = `run-guidance-loop-${randomUUID()}`
    sessions.add(sessionId)
    let requests = 0
    let secondRequest: any
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests++
        const body = await request.json()
        if (requests === 2) secondRequest = body
        return mockOpenAiStream(requests === 1 ? "正在生成演示文稿" : "已根据反馈修复并重新验证演示文稿")
      },
    })
    try {
      SessionRepo.create({
        id: sessionId,
        title: "run guidance loop",
        agent_id: "main-agent",
        project_path: root,
      })
      const agents = new AgentRegistry()
      agents.registerAll(HIDDEN_AGENTS)
      const loop = new AgentLoop({
        toolRegistry: new ToolRegistry(),
        agentRegistry: agents,
        modelRouter: new ModelRouter([{
          id: "run-guidance-loop",
          name: "Run Guidance Loop",
          provider: "openai-compatible",
          modelId: "run-guidance-loop",
          apiKey: "test",
          baseUrl: `http://127.0.0.1:${server.port}`,
          capabilities: ["reasoning", "coding", "chat"],
          priority: 1,
          costFactor: 1,
          enabled: true,
          contextWindow: 32_000,
          maxOutputTokens: 2_048,
        }]),
      }, 4)
      let drains = 0
      const events: any[] = []
      for await (const event of loop.run({
        runId: `task-${randomUUID()}`,
        runType: "root",
        sessionId,
        userMessage: "生成可打开的 PPTX",
        agentId: "main-agent",
        workingDir: root,
        scope: "confirm-changes",
        drainGuidance: () => {
          drains++
          return drains === 2 ? [{
            requestId: "guidance-late",
            message: "PPTX 仍然无法打开，请继续当前任务进行修复",
          }] : []
        },
      })) events.push(event)

      expect(requests).toBe(2)
      expect(JSON.stringify(secondRequest?.messages ?? [])).toContain("PPTX 仍然无法打开")
      expect(events.some((event) => event.type === "guidance-applied"
        && event.requestId === "guidance-late")).toBe(true)
      expect(events.filter((event) => event.type === "text-delta")
        .map((event) => event.text).join(""))
        .toContain("已根据反馈修复")
    } finally {
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

async function submit(body: Record<string, unknown>): Promise<Response> {
  const request = new Request("http://eval.local/api/tasks/guidance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const response = await handleTaskRoutes(request, new URL(request.url), {})
  if (!response) throw new Error("guidance route did not handle request")
  return response
}

function activeTask(): { sessionId: string; task: TaskRunView } {
  const sessionId = `run-guidance-test-${randomUUID()}`
  SessionRepo.create({
    id: sessionId,
    title: "run guidance test",
    agent_id: "main-agent",
    project_path: ".",
  })
  sessions.add(sessionId)
  const task: TaskRunView = {
    id: `task-${randomUUID()}`,
    requestId: randomUUID(),
    sessionId,
    agentId: "main-agent",
    priority: 8,
    status: "running",
    message: "active task",
    workingDir: process.cwd(),
    type: "chat",
    scope: "confirm-changes",
    effort: "on",
    createdAt: Date.now(),
    startedAt: Date.now(),
  }
  TaskRunRepo.create(task)
  return { sessionId, task }
}

function mockOpenAiStream(content: string): Response {
  const chunk = { choices: [{ delta: { content }, finish_reason: "stop" }] }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}
