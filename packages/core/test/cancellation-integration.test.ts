import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { AgentRegistry } from "../src/agent/registry.ts"
import type { AgentDefinition } from "../src/agent/types.ts"
import { ModelRouter } from "../src/model-router/index.ts"
import { AgentLoop, type AgentLoopInput } from "../src/runtime/agent-loop.ts"
import { AgentOrchestrator } from "../src/runtime/orchestrator.ts"
import { handleChat } from "../src/runtime/server-chat.ts"
import {
  SESSION_COMMAND_PROCESS_EPOCH,
} from "../src/runtime/session-command-queue.ts"
import { taskScheduler, type ScheduledTask } from "../src/runtime/task-scheduler.ts"
import { WorkflowEngine } from "../src/runtime/workflow-engine.ts"
import { SessionCommandRepo } from "../src/store/session-command.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"
import { WorkflowRepo } from "../src/store/workflow.ts"
import { WorkflowTemplateRepo } from "../src/store/workflow-template.ts"
import { taskTool } from "../src/tool/general/task.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import type { ToolContext, ToolDefinition } from "../src/tool/types.ts"

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function abortError(message = "worker cancelled"): Error {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

async function eventually<T>(
  read: () => T | null | undefined,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value != null && accept(value)) return value
    await Bun.sleep(10)
  }
  throw new Error(`等待超时: ${label}`)
}

function completeOrCancel(task: ScheduledTask | undefined): void {
  if (!task) return
  const current = taskScheduler.getTask(task.id)
  if (!current) return
  if (current.status === "running") taskScheduler.completeTask(current.id, "test cleanup")
  else if (current.status === "queued") taskScheduler.cancel(current.id)
}

function openAiToolCall(name: string, input: Record<string, unknown> = {}): Response {
  const chunk = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: `call-${crypto.randomUUID()}`,
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function openAiText(content: string): Response {
  const chunk = { choices: [{ delta: { content }, finish_reason: "stop" }] }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function blockingAgentHarness(targetPath: string) {
  const entered = deferred<ToolContext>()
  const release = deferred<void>()
  let requestCount = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      requestCount++
      return requestCount === 1
        ? openAiToolCall("block_until_released", { path: targetPath })
        : openAiText("unexpected continuation")
    },
  })
  const tool: ToolDefinition = {
    name: "block_until_released",
    description: "Test worker which remains alive after cancellation until its execution body is released",
    permission: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    contract: {
      effects: ["workspace-read"],
      idempotency: "read-only",
      cancellation: "cooperative",
      progress: { role: "inspection", targetParameters: ["path"] },
    },
    async execute(_input, context) {
      entered.resolve(context)
      if (!context.abortSignal) throw new Error("blocking test tool requires an abort signal")
      await waitForAbort(context.abortSignal)
      await release.promise
      return {
        success: false,
        error: "worker observed cancellation",
        outcome: {
          status: "cancelled",
          category: "generic",
          summary: "worker observed cancellation",
        },
      }
    },
  }
  const agent: AgentDefinition = {
    id: "blocking-worker",
    name: "Blocking worker",
    description: "Cancellation integration worker",
    mode: "hidden",
    requiredCapabilities: ["reasoning"],
    tools: [tool.name],
    permissions: [{ permission: "read", pattern: "*", effect: "allow" }],
    systemPrompt: "Call the only available tool.",
    maxSteps: 4,
  }
  const tools = new ToolRegistry()
  tools.register(tool)
  const agents = new AgentRegistry()
  agents.register(agent)
  const router = new ModelRouter([{
    id: "blocking-model",
    name: "Blocking model",
    provider: "openai-compatible",
    modelId: "blocking-model",
    apiKey: "test",
    baseUrl: `http://127.0.0.1:${server.port}`,
    capabilities: ["reasoning", "coding", "chat"],
    priority: 1,
    costFactor: 1,
    enabled: true,
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
  }])
  return {
    entered,
    release: () => release.resolve(),
    close: () => server.stop(true),
    tools,
    agents,
    router,
    loop: new AgentLoop({ toolRegistry: tools, agentRegistry: agents, modelRouter: router }, 4),
  }
}

function blockingRootLoop() {
  const entered = deferred<AgentLoopInput>()
  const release = deferred<void>()
  const loop = {
    async *run(input: AgentLoopInput) {
      entered.resolve(input)
      if (!input.abortSignal) throw new Error("root cancellation test requires an abort signal")
      await waitForAbort(input.abortSignal)
      await release.promise
      throw abortError()
    },
  } as AgentLoop
  return { loop, entered, release: () => release.resolve() }
}

describe("worker-owned cancellation lease integration", () => {
  test("root run keeps its conversation lane until the real SSE worker exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-root-cancel-"))
    const sessionId = `root-cancel-${crypto.randomUUID()}`
    const requestId = `request-${crypto.randomUUID()}`
    const blocker = blockingRootLoop()
    const tools = new ToolRegistry()
    const agents = new AgentRegistry()
    agents.registerAll(HIDDEN_AGENTS)
    const router = new ModelRouter([{
      id: "unused-root-model",
      name: "Unused root model",
      provider: "openai-compatible",
      modelId: "unused-root-model",
      apiKey: "test",
      baseUrl: "http://127.0.0.1:1",
      capabilities: ["reasoning", "coding", "chat"],
      priority: 1,
      costFactor: 1,
      enabled: true,
      contextWindow: 32_000,
      maxOutputTokens: 2_048,
    }])
    const body = {
      message: "保持根执行体运行，直到收到取消",
      sessionId,
      requestId,
      workingDir: root,
      scope: "full-access",
      effort: "off",
    }
    SessionCommandRepo.enqueue({ requestId, sessionId, payload: JSON.stringify(body) })
    let responseRead: Promise<string> | undefined
    let competing: ScheduledTask | undefined
    try {
      const response = await handleChat(new Request("http://local/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-eval-command-dispatcher": SESSION_COMMAND_PROCESS_EPOCH,
        },
        body: JSON.stringify(body),
      }), {}, {
        agentLoop: blocker.loop,
        agentRegistry: agents,
        toolRegistry: tools,
        modelRouter: router,
        orchestrator: new AgentOrchestrator(() => agents.list()),
        conversationTurnResolver: async () => ({
          kind: "new-objective",
          confidence: 1,
        }),
        semanticTaskAnalyzer: async () => ({
          goalType: "general",
          complexity: "simple",
          requiredEffects: [],
          candidateAgentIds: ["general"],
          requiresPlanning: false,
          acceptanceRequirements: [],
          source: "model",
        }),
      })
      responseRead = response.text()
      await blocker.entered.promise
      const rootTask = await eventually(
        () => TaskRunRepo.getByRequestId(requestId),
        (task) => task.status === "running",
        "root task running",
      )

      expect(taskScheduler.cancel(rootTask.id)).toBe(true)
      await eventually(
        () => taskScheduler.getTask(rootTask.id),
        (task) => task.status === "cancelling",
        "root task cancelling",
      )
      competing = taskScheduler.enqueue({
        sessionId,
        agentId: "test-competitor",
        priority: 1,
        type: "background",
        message: "same conversation lane",
        workingDir: root,
      })

      expect(taskScheduler.getRunning().some((task) =>
        task.id === rootTask.id && task.status === "cancelling")).toBe(true)
      expect(competing.status).toBe("queued")

      blocker.release()
      const stream = await responseRead
      await eventually(
        () => taskScheduler.getTask(rootTask.id),
        (task) => task.status === "cancelled",
        "root worker exit acknowledgement",
      )
      await eventually(
        () => taskScheduler.getTask(competing!.id),
        (task) => task.status === "running",
        "conversation lane released after root finally",
      )
      expect(TaskRunRepo.get(rootTask.id)?.status).toBe("cancelled")
      expect(stream).toContain('"status":"cancelled"')
      expect(stream).not.toContain('event: done\ndata: {"sessionId":"' + sessionId + '","taskId":"' + rootTask.id + '","status":"cancelling"')
    } finally {
      blocker.release()
      await responseRead?.catch(() => "")
      completeOrCancel(competing)
      SessionCommandRepo.deleteBySession(sessionId)
      SessionRepo.delete(sessionId)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("delegated child keeps its resource lease until taskTool's worker finally exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-child-cancel-"))
    const sessionId = `child-cancel-${crypto.randomUUID()}`
    const harness = blockingAgentHarness("shared-resource/file.txt")
    SessionRepo.create({
      id: sessionId,
      title: "child cancellation",
      agent_id: "main-agent",
      project_path: root,
    })
    const parent = taskScheduler.enqueue({
      sessionId,
      agentId: "main-agent",
      priority: 8,
      type: "chat",
      message: "delegate blocking child",
      workingDir: root,
    })
    let competing: ScheduledTask | undefined
    try {
      const execution = taskTool.execute({
        subagent_name: "blocking-worker",
        description: "blocking delegated worker",
        prompt: "Call block_until_released and wait.",
        acceptance: ["已读取并检查共享资源"],
        acceptance_criteria: [{
          statement: "已读取并检查共享资源",
          verifier: "workspace-inspection",
          targetPatterns: ["shared-resource/**"],
        }],
        required_effects: ["workspace-read"],
        read_targets: ["shared-resource/**"],
      }, {
        runId: parent.id,
        runType: "root",
        sessionId,
        permissionContextId: sessionId,
        agentId: "main-agent",
        workingDir: root,
        scope: "full-access",
        preferredModelId: "blocking-model",
        modelFallbackEnabled: false,
        agentRegistry: harness.agents,
        toolRegistry: harness.tools,
        modelRouter: harness.router,
        executionDeadline: Date.now() + 30_000,
        executionBudget: {
          rootWindowMs: 30_000,
          childLeaseMs: 20_000,
          parentReserveMs: 5_000,
          minimumChildLeaseMs: 1_000,
          maxStagnantSegments: 2,
        },
      })
      await Promise.race([
        harness.entered.promise,
        execution.then((result) => {
          throw new Error(`delegated worker exited before entering its tool: ${JSON.stringify(result)}`)
        }),
      ])
      const child = await eventually(
        () => TaskRunRepo.listByParent(parent.id).at(-1),
        (task) => task.status === "running",
        "delegated child running",
      )
      const liveChild = taskScheduler.getTask(child.id)!
      const resource = liveChild.resourceClaims?.reads[0]
      expect(resource).toBeTruthy()

      expect(taskScheduler.cancel(child.id)).toBe(true)
      await eventually(
        () => taskScheduler.getTask(child.id),
        (task) => task.status === "cancelling",
        "delegated child cancelling",
      )
      competing = taskScheduler.enqueue({
        sessionId,
        agentId: "test-competitor",
        priority: 1,
        type: "background",
        message: "conflicting writer",
        workingDir: root,
        laneKey: `integration:${sessionId}:child-competitor`,
        resourceClaims: { reads: [], writes: [resource!] },
      })

      expect(taskScheduler.getRunning().some((task) =>
        task.id === child.id && task.status === "cancelling")).toBe(true)
      expect(competing.status).toBe("queued")

      harness.release()
      await Promise.race([
        execution,
        Bun.sleep(2_000).then(() => {
          const childState = taskScheduler.getTask(child.id)?.status
          const parentState = taskScheduler.getTask(parent.id)?.status
          const competitorState = taskScheduler.getTask(competing!.id)?.status
          throw new Error(
            `taskTool cancellation did not settle: child=${childState}, parent=${parentState}, competitor=${competitorState}`,
          )
        }),
      ])
      await eventually(
        () => taskScheduler.getTask(child.id),
        (task) => task.status === "cancelled",
        "delegated worker exit acknowledgement",
      )
      await eventually(
        () => taskScheduler.getTask(competing!.id),
        (task) => task.status === "running",
        "delegated resource lease released after finally",
      )
      expect(TaskRunRepo.get(child.id)?.status).toBe("cancelled")
    } finally {
      harness.release()
      completeOrCancel(competing)
      completeOrCancel(parent)
      harness.close()
      SessionRepo.delete(sessionId)
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  test("workflow node keeps its resource lease until WorkflowEngine's worker finally exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-workflow-cancel-"))
    const sessionId = `workflow-cancel-${crypto.randomUUID()}`
    const harness = blockingAgentHarness("workflow-resource/file.txt")
    SessionRepo.create({
      id: sessionId,
      title: "workflow cancellation",
      agent_id: "main-agent",
      project_path: root,
    })
    const engine = new WorkflowEngine(harness.loop, harness.agents, harness.router, harness.tools)
    const template = engine.createTemplate({
      name: "blocking cancellation workflow",
      description: "integration test",
      nodes: [{
        id: "blocking-node",
        title: "blocking node",
        agentId: "blocking-worker",
        prompt: "Call block_until_released and wait.",
        dependsOn: [],
        readTargets: ["workflow-resource/**"],
      }],
      failurePolicy: { maxRetries: 0, delaySeconds: 0, siblingFailure: "fail-fast" },
    })
    const workflow = engine.create({
      sessionId,
      templateId: template.id,
      goal: "exercise workflow cancellation ownership",
      workingDir: root,
    })
    let competing: ScheduledTask | undefined
    try {
      engine.start(workflow.id)
      await harness.entered.promise
      const nodeTask = await eventually(
        () => {
          const node = WorkflowRepo.get(workflow.id)?.nodes[0]
          return node?.taskRunId ? taskScheduler.getTask(node.taskRunId) : undefined
        },
        (task) => task.status === "running",
        "workflow node running",
      )
      const resource = nodeTask.resourceClaims?.reads[0]
      expect(resource).toBeTruthy()

      engine.cancel(workflow.id)
      await eventually(
        () => taskScheduler.getTask(nodeTask.id),
        (task) => task.status === "cancelling",
        "workflow node cancelling",
      )
      competing = taskScheduler.enqueue({
        sessionId,
        agentId: "test-competitor",
        priority: 1,
        type: "background",
        message: "conflicting workflow writer",
        workingDir: root,
        laneKey: `integration:${sessionId}:workflow-competitor`,
        resourceClaims: { reads: [], writes: [resource!] },
      })

      expect(taskScheduler.getRunning().some((task) =>
        task.id === nodeTask.id && task.status === "cancelling")).toBe(true)
      expect(competing.status).toBe("queued")

      harness.release()
      await eventually(
        () => taskScheduler.getTask(nodeTask.id),
        (task) => task.status === "cancelled",
        "workflow worker exit acknowledgement",
      )
      await eventually(
        () => WorkflowRepo.get(workflow.id),
        (run) => run.status === "cancelled",
        "workflow cancellation completed",
      )
      await eventually(
        () => taskScheduler.getTask(competing!.id),
        (task) => task.status === "running",
        "workflow resource lease released after finally",
      )
      expect(TaskRunRepo.get(nodeTask.id)?.status).toBe("cancelled")
    } finally {
      harness.release()
      engine.close()
      completeOrCancel(competing)
      WorkflowRepo.delete(workflow.id)
      WorkflowTemplateRepo.delete(template.id)
      harness.close()
      SessionRepo.delete(sessionId)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
