import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { AgentRegistry } from "../src/agent/registry.ts"
import { ModelRouter } from "../src/model-router/index.ts"
import { AgentLoop } from "../src/runtime/agent-loop.ts"
import { AgentOrchestrator } from "../src/runtime/orchestrator.ts"
import { handleChat } from "../src/runtime/server-chat.ts"
import { SESSION_COMMAND_PROCESS_EPOCH } from "../src/runtime/session-command-queue.ts"
import { OrchestrationLogRepo } from "../src/store/orchestration-log.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { RunContractRepo } from "../src/store/run-contract.ts"
import { SessionCommandRepo } from "../src/store/session-command.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"
import { ToolExecutionRepo } from "../src/store/tool-execution.ts"
import { defineTool } from "../src/tool/define.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import { EMBEDDED_TOOLS } from "../src/tool/tools-index.ts"

const REQUEST = "请给我一个电源设计方案，将12V的太阳能板转换成220V的家用电的逆变方案"
const ACCEPTANCE = "公开资料与高压安全边界已经核验"

test("an informational research request stays outside execution planning", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-planned-research-system-"))
  const sessionId = `planned-research-${crypto.randomUUID()}`
  const requestId = `planned-research-request-${crypto.randomUUID()}`
  let planCalls = 0
  let taskCalls = 0
  let researchCalls = 0
  let childFinals = 0
  let rootFinals = 0
  const modelRequests: Array<{ tools: string[]; toolChoice?: unknown }> = []

  const researchTool = defineTool({
    name: "websearch",
    description: "Deterministic external research adapter used by the system test.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async execute({ query }: { query: string }) {
      return {
        success: true,
        data: {
          query,
          results: [{
            title: "Grid-connected and stand-alone inverter safety overview",
            url: "https://example.invalid/inverter-safety",
            snippet: "Use certified isolation, protection, enclosure and qualified commissioning.",
          }],
        },
      }
    },
    contract: {
      effects: ["network"],
      idempotency: "idempotent",
      cancellation: "cooperative",
      progress: { role: "verification", verificationScope: "global" },
    },
    permission: "websearch",
  })

  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as {
          tools?: Array<{ function?: { name?: string } }>
          tool_choice?: unknown
        }
        const tools = (body.tools ?? [])
          .map((item) => item.function?.name)
          .filter((name): name is string => typeof name === "string")
        modelRequests.push({ tools, toolChoice: body.tool_choice })

        // Tool visibility is capability, not an instruction to plan or
        // delegate. The response-only conversation authority disables
        // automatic planning while the model remains free to answer directly.
        if (modelRequests.length === 1) {
          rootFinals++
          return mockOpenAiStream({
            content: "Conceptual design and safety boundaries complete: use a certified isolated inverter architecture and qualified mains-side commissioning.",
          })
        }

        if (tools.includes("plan")) {
          planCalls++
          return mockOpenAiStream({ toolCalls: [{
            id: "plan-solar-inverter",
            name: "plan",
            input: {
              contract: {
                schemaVersion: 1,
                planId: "solar-inverter-research",
                version: 1,
                title: "12V solar inverter architecture and safety research",
                nodes: [{
                  nodeId: "research-safety",
                  title: "Research inverter architecture and safety boundaries",
                  instruction: "Research a conceptual architecture and safety boundaries. Do not provide hazardous mains wiring instructions.",
                  goalType: "research",
                  dependsOn: [],
                  assigneeAgentId: "researcher",
                  requiredEffects: ["network"],
                  resources: { reads: [], writes: [] },
                  acceptance: [{
                    id: "external-safety-research",
                    label: ACCEPTANCE,
                    anyOf: ["external-research"],
                    targetPatterns: [],
                  }],
                  expectedOutputs: [],
                  blockingClass: "none",
                }],
              },
            },
          }] })
        }

        if (tools.includes("websearch") && !tools.includes("task")) {
          researchCalls++
          return mockOpenAiStream({ toolCalls: [{
            id: "research-inverter-safety",
            name: "websearch",
            input: { query: "12V solar inverter 220V safety isolation protection standards" },
          }] })
        }

        const rootRunId = SessionCommandRepo.get(requestId)?.taskId
        const child = rootRunId
          ? RunContractRepo.listByParent(rootRunId).at(-1)
          : undefined
        if (modelRequests.length === 1 && tools.includes("task")) {
          if (child?.result) {
            rootFinals++
            return mockOpenAiStream({
              content: "Conceptual design and safety boundaries complete.",
            })
          }
          taskCalls++
          return mockOpenAiStream({ toolCalls: [{
            id: "delegate-inverter-research",
            name: "task",
            input: {
              subagent_name: "researcher",
              description: "Research conceptual inverter architecture and safety boundaries",
              prompt: "Follow the approved plan and return a concise evidence-backed result.",
              plan_id: "solar-inverter-research",
              plan_version: 1,
              plan_node_id: "research-safety",
            },
          }] })
        }

        if (tools.length === 0 && researchCalls > 0 && childFinals === 0) {
          childFinals++
          return mockOpenAiStream({
            content: "Research completed: use a certified low-voltage DC stage, isolated conversion, protected output stage, enclosure, and qualified mains commissioning.",
          })
        }
        if (tools.length === 0) {
          rootFinals++
          return mockOpenAiStream({
            content: "已完成概念方案与安全边界核验：建议采用受认证的隔离式逆变架构，并由具备资质的人员完成市电侧设计、保护与验收。",
          })
        }
        throw new Error(`Unexpected model request tools: ${tools.join(",")}`)
      },
    })

    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS.filter((tool) => tool.name !== "websearch"))
    toolRegistry.register(researchTool)
    const modelRouter = new ModelRouter([{
      id: "planned-research-system",
      name: "Planned Research System",
      provider: "openai-compatible",
      modelId: "planned-research-system",
      apiKey: "test",
      baseUrl: `http://127.0.0.1:${server.port}`,
      capabilities: ["reasoning", "coding", "chat", "search"],
      priority: 1,
      costFactor: 1,
      enabled: true,
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
    }])
    const agentLoop = new AgentLoop({ toolRegistry, agentRegistry, modelRouter }, 12)
    const payload = {
      message: REQUEST,
      sessionId,
      requestId,
      workingDir: root,
      scope: "full-access",
      effort: "off",
      modelId: "planned-research-system",
    }
    SessionCommandRepo.enqueue({ requestId, sessionId, payload: JSON.stringify(payload) })

    const response = await handleChat(new Request("http://local/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eval-command-dispatcher": SESSION_COMMAND_PROCESS_EPOCH,
      },
      body: JSON.stringify(payload),
    }), {}, {
      agentLoop,
      agentRegistry,
      toolRegistry,
      modelRouter,
      orchestrator: new AgentOrchestrator(() => agentRegistry.list()),
      conversationTurnResolver: async () => ({
        kind: "domain-query",
        confidence: 1,
      }),
      semanticTaskAnalyzer: async () => ({
        goalType: "research",
        complexity: "complex",
        requiredEffects: ["network"],
        candidateAgentIds: ["researcher"],
        requiresPlanning: true,
        acceptanceRequirements: [{
          id: "external-safety-research",
          label: ACCEPTANCE,
          verifier: "research",
          anyOf: ["external-research"],
          targetPatterns: [],
        }],
        source: "model",
      }),
    })

    expect(response.status).toBe(200)
    const stream = await response.text()
    const command = SessionCommandRepo.get(requestId)
    expect(command?.taskId).toBeTruthy()
    if (command?.state !== "completed") {
      const taskExecutions = ToolExecutionRepo.listBySession(sessionId, 100)
        .filter((execution) => execution.toolName === "task")
      const taskFailure = taskExecutions.find((execution) =>
        execution.runtimeOutcome?.diagnostic?.kind !== "repeated-invocation")
        ?? taskExecutions.at(-1)
      throw new Error(JSON.stringify({
        command,
        counters: { planCalls, taskCalls, researchCalls, reviewCalls, childFinals, rootFinals },
        taskFailure: taskFailure ? {
          status: taskFailure.status,
          error: taskFailure.error,
          fingerprint: taskFailure.runtimeOutcome?.fingerprint,
          category: taskFailure.runtimeOutcome?.category,
          diagnosticKind: taskFailure.runtimeOutcome?.diagnostic?.kind,
          nextActions: taskFailure.runtimeOutcome?.diagnostic?.nextActions,
        } : undefined,
        modelRequests,
        stream,
        logs: OrchestrationLogRepo.list({ sessionId, limit: 200 }).map((entry) => ({
          eventType: entry.eventType,
          message: entry.message,
          data: entry.data,
        })),
      }, null, 2))
    }
    expect(command).toMatchObject({ state: "completed" })
    expect(TaskRunRepo.get(command!.taskId!)).toMatchObject({
      agentId: "main-agent",
      status: "completed",
    })
    expect(RunContractRepo.listByParent(command!.taskId!)).toHaveLength(0)

    const eventTypes = OrchestrationLogRepo.list({
      sessionId,
      limit: 500,
    }).map((entry) => entry.eventType)
    expect(eventTypes).toEqual(expect.arrayContaining([
      "root.admitted",
      "root.selected",
      "public-event.done",
    ]))
    for (const internalEvent of [
      "root.tasks-published",
      "delegation.started",
    ]) {
      expect(eventTypes).not.toContain(internalEvent)
    }
    expect(eventTypes).not.toContain("execution.contract-rejected")
    expect(stream).toContain("event: done")
    expect(stream).toContain('"status":"completed"')
    expect(stream).toContain("Conceptual design and safety boundaries complete")

    expect(planCalls).toBe(0)
    expect(taskCalls).toBe(0)
    expect(researchCalls).toBe(0)
    expect(childFinals).toBe(0)
    expect(rootFinals).toBe(1)
    expect(modelRequests).toHaveLength(1)
    expect(modelRequests[0]?.tools).toContain("plan")
    expect(modelRequests[0]?.tools).toContain("task")
    expect(modelRequests[0]?.toolChoice).not.toBe("required")
  } finally {
    server?.stop(true)
    SessionRepo.delete(sessionId)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("a non-retryable delegation failure executes only once across the root run", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-planned-research-failure-"))
  const sessionId = `planned-research-failure-${crypto.randomUUID()}`
  const requestId = `planned-research-failure-request-${crypto.randomUUID()}`
  let taskExecutions = 0
  const modelRequests: Array<{ tools: string[] }> = []
  const failingTask = defineTool({
    name: "task",
    description: "Deterministic non-retryable delegation failure.",
    parameters: { type: "object", properties: {} },
    async execute() {
      taskExecutions++
      return {
        success: false,
        error: "delegated role cannot satisfy the immutable contract",
        outcome: {
          status: "failed" as const,
          category: "generic" as const,
          summary: "delegation capability preflight failed",
          fingerprint: "task-capability:researcher:process",
          diagnostic: {
            kind: "atomic-task-capability-mismatch",
            evidence: ["required:process"],
            nextActions: ["revise the contract or select a capable role"],
            retryable: false,
          },
        },
      }
    },
    contract: {
      effects: ["delegation"],
      idempotency: "non-idempotent",
      cancellation: "cooperative",
      progress: { role: "delegation" },
    },
    permission: "task",
  })

  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as {
          tools?: Array<{ function?: { name?: string } }>
        }
        const tools = (body.tools ?? [])
          .map((item) => item.function?.name)
          .filter((name): name is string => typeof name === "string")
        modelRequests.push({ tools })
        if (taskExecutions === 0 && tools.includes("task")) {
          return mockOpenAiStream({ toolCalls: [{
            id: "delegate-once",
            name: "task",
            input: {
              subagent_name: "researcher",
              plan_id: "immutable-plan",
              plan_version: 1,
              plan_node_id: "research",
            },
          }] })
        }
        return mockOpenAiStream({
          content: "我已根据失败证据调整处理方式，并给出当前可行的下一步。",
        })
      },
    })

    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS.filter((tool) => tool.name !== "task"))
    toolRegistry.register(failingTask)
    const modelRouter = new ModelRouter([{
      id: "planned-research-failure",
      name: "Planned Research Failure",
      provider: "openai-compatible",
      modelId: "planned-research-failure",
      apiKey: "test",
      baseUrl: `http://127.0.0.1:${server.port}`,
      capabilities: ["reasoning", "coding", "chat"],
      priority: 1,
      costFactor: 1,
      enabled: true,
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
    }])
    const payload = {
      message: "Delegate one immutable research task and stop on a non-retryable contract failure.",
      sessionId,
      requestId,
      workingDir: root,
      scope: "full-access",
      effort: "off",
      modelId: "planned-research-failure",
    }
    SessionCommandRepo.enqueue({ requestId, sessionId, payload: JSON.stringify(payload) })

    const response = await handleChat(new Request("http://local/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eval-command-dispatcher": SESSION_COMMAND_PROCESS_EPOCH,
      },
      body: JSON.stringify(payload),
    }), {}, {
      agentLoop: new AgentLoop({ toolRegistry, agentRegistry, modelRouter }, 12),
      agentRegistry,
      toolRegistry,
      modelRouter,
      orchestrator: new AgentOrchestrator(() => agentRegistry.list()),
      conversationTurnResolver: async () => ({ kind: "new-objective", confidence: 1 }),
      semanticTaskAnalyzer: async () => ({
        goalType: "general",
        complexity: "simple",
        requiredEffects: ["workspace-read", "delegation"],
        candidateAgentIds: ["general"],
        requiresPlanning: false,
        acceptanceRequirements: [{
          id: "delegated-result",
          label: "委派结果已经安全取得",
          verifier: "workspace-inspection",
          anyOf: ["workspace-inspection"],
          targetPatterns: [],
        }],
        source: "model",
      }),
    })

    const responseText = await response.text()
    if (response.status !== 200) throw new Error(responseText)
    expect(SessionCommandRepo.get(requestId)?.state).toBe("completed")
    expect(taskExecutions).toBe(1)
    expect(modelRequests).toHaveLength(2)
    expect(modelRequests[0]?.tools).toContain("task")
    expect(modelRequests[1]?.tools).toContain("task")
    const durableTaskExecutions = ToolExecutionRepo.listBySession(sessionId, 100)
      .filter((execution) => execution.toolName === "task")
    expect(durableTaskExecutions).toHaveLength(1)
    expect(durableTaskExecutions[0]?.runtimeOutcome).toMatchObject({
      fingerprint: "task-capability:researcher:process",
      diagnostic: {
        kind: "atomic-task-capability-mismatch",
        retryable: false,
      },
    })
  } finally {
    server?.stop(true)
    SessionRepo.delete(sessionId)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

function mockOpenAiStream(input: {
  content?: string
  finishReason?: string
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>
}): Response {
  const delta = input.toolCalls?.length
    ? {
        tool_calls: input.toolCalls.map((call, index) => ({
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      }
    : { content: input.content ?? "" }
  const chunk = {
    choices: [{
      delta,
      finish_reason: input.finishReason ?? (input.toolCalls?.length ? "tool_calls" : "stop"),
    }],
  }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}
