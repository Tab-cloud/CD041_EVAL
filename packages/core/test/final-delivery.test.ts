import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { AgentRegistry } from "../src/agent/registry.ts"
import { ModelRouter } from "../src/model-router/index.ts"
import { AgentLoop } from "../src/runtime/agent-loop.ts"
import type { ExecutionSnapshot } from "../src/runtime/agent-loop-control.ts"
import { finalDeliveryEvents, finalDeliveryPolicy } from "../src/runtime/final-delivery.ts"
import { MainAgentMessageAccumulator } from "../src/runtime/main-agent-message.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { readTool, writeTool } from "../src/tool/fs/index.ts"
import { ToolRegistry } from "../src/tool/registry.ts"

test("runtime evidence provides a deterministic delivery without changing execution state", () => {
  const snapshot: ExecutionSnapshot = {
    state: "completed",
    todos: [{ content: "读取手册并生成总结", status: "completed", priority: "high" }],
    segment: 0,
    idleTurns: 0,
    toolRounds: 2,
    limit: 8,
    consecutiveNoProgress: 0,
    objectiveEvidenceBindings: [{
      requirementId: "mutation",
      kind: "workspace-mutation",
      targets: ["manual-summary.md"],
      globalVerification: false,
      source: "write-1",
    }],
    runtimeObjectiveAccepted: true,
    updatedAt: Date.now(),
  }

  const delivery = finalDeliveryPolicy.resolve({
    snapshot,
    modelError: "最终总结模型轮次协议异常",
  })

  expect(delivery.source).toBe("runtime-fallback")
  expect(delivery.text).toContain("任务已完成")
  expect(delivery.text).toContain("manual-summary.md")
  expect(snapshot.state).toBe("completed")
})

test("a runtime fallback streams once and is committed as one assistant message", () => {
  const delivery = finalDeliveryPolicy.resolve({
    snapshot: {
      state: "completed",
      todos: [{ content: "生成总结", status: "completed", priority: "high" }],
      segment: 0,
      idleTurns: 0,
      toolRounds: 1,
      limit: 8,
      consecutiveNoProgress: 0,
      runtimeObjectiveAccepted: true,
      updatedAt: Date.now(),
    },
    modelError: "最终总结协议异常",
  })
  const ledger = new MainAgentMessageAccumulator()
  const streamed: string[] = []

  for (const event of finalDeliveryEvents(delivery, 3)) {
    if (event.type === "finish") ledger.finishRound(0, event._step)
    else {
      streamed.push(event.text)
      ledger.observeText(0, event._step, event.text)
    }
  }

  expect(streamed).toEqual([delivery.text])
  expect(ledger.delivery()).toBe(delivery.text)
})

test("tool results return to a normal model turn without an acceptance-only phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-final-delivery-"))
  const sessionId = `final-delivery-${crypto.randomUUID()}`
  let requests = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as {
        tools?: Array<{ function?: { name?: string } }>
      }
      requests++
      if (requests === 1) {
        return mockOpenAiStream({
          toolCalls: [{
            id: "write-summary",
            name: "write",
            input: { path: "manual-summary.md", content: "# 手册总结\n\n已完成。\n" },
          }],
        })
      }
      if (requests === 2) {
        return mockOpenAiStream({
          toolCalls: [{ id: "verify-summary", name: "read", input: { paths: ["manual-summary.md"] } }],
        })
      }
      expect((body.tools ?? []).map((tool) => tool.function?.name))
        .toEqual(expect.arrayContaining(["read", "write"]))
      return mockOpenAiStream({ content: "任务已完成，文件已生成并核验。" })
    },
  })

  try {
    const tools = new ToolRegistry()
    tools.register(writeTool)
    tools.register(readTool)
    const agents = new AgentRegistry()
    agents.registerAll(HIDDEN_AGENTS)
    const router = new ModelRouter([{
      id: "final-delivery-model",
      name: "Final Delivery Model",
      provider: "openai-compatible",
      modelId: "final-delivery-model",
      apiKey: "test",
      baseUrl: `http://127.0.0.1:${server.port}`,
      capabilities: ["reasoning", "coding", "chat"],
      priority: 1,
      costFactor: 1,
      enabled: true,
      contextWindow: 32_000,
      maxOutputTokens: 2_048,
    }])
    SessionRepo.create({
      id: sessionId,
      title: "final delivery isolation",
      agent_id: "main-agent",
      project_path: root,
    })
    const snapshots: ExecutionSnapshot[] = []
    const events: Array<{ type: string; text?: string; message?: string; _step?: number }> = []
    const deliveryLedger = new MainAgentMessageAccumulator()
    const loop = new AgentLoop({ toolRegistry: tools, agentRegistry: agents, modelRouter: router }, 8)
    for await (const event of loop.run({
      sessionId,
      runId: sessionId,
      runType: "root",
      userMessage: "生成并核验 manual-summary.md",
      agentId: "main-agent",
      workingDir: root,
      scope: "full-access",
      preferredModelId: "final-delivery-model",
      modelFallbackEnabled: false,
      objectiveEffects: ["workspace-read", "workspace-write"],
      objectiveAcceptancePolicy: {
        requirements: [
          {
            id: "mutation",
            label: "生成总结文件",
            anyOf: ["workspace-mutation"],
            targetPatterns: ["manual-summary.md"],
          },
          {
            id: "inspection",
            label: "核验总结文件",
            anyOf: ["workspace-inspection"],
            targetPatterns: ["manual-summary.md"],
          },
        ],
      },
      executionState: { persist: (snapshot) => snapshots.push(snapshot) },
    })) {
      events.push(event)
      const round = event._step ?? 0
      if (event.type === "tool-call") deliveryLedger.observeToolCall(0, round)
      else if (event.type === "finish") deliveryLedger.finishRound(0, round)
      else if (event.type === "text-delta") deliveryLedger.observeText(0, round, event.text)
    }

    expect(requests).toBe(3)
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""))
      .toContain("任务已完成")
    expect(deliveryLedger.delivery()).toContain("任务已完成")
    expect(snapshots.at(-1)?.state).toBe("completed")
    expect(snapshots.at(-1)?.runtimeObjectiveAccepted).toBe(true)
    expect(readFileSync(join(root, "manual-summary.md"), "utf8")).toContain("已完成")
  } finally {
    server.stop(true)
    SessionRepo.delete(sessionId)
    rmSync(root, { recursive: true, force: true })
  }
})

test("a document write returns to the model with tools available and no forced verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-document-completion-"))
  const sessionId = `document-completion-${crypto.randomUUID()}`
  const sourcePath = join(root, "manual.txt")
  await Bun.write(sourcePath, "CPU: Cortex-A53\nStorage: eMMC\n")
  const requests: Array<{ tools: string[]; toolChoice: unknown }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as {
        tools?: Array<{ function?: { name?: string } }>
        tool_choice?: unknown
      }
      requests.push({
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
        toolChoice: body.tool_choice,
      })
      if (requests.length === 1) {
        return mockOpenAiStream({
          toolCalls: [
            { id: "read-manual", name: "read", input: { paths: ["manual.txt"] } },
            {
              id: "write-summary",
              name: "write",
              input: { path: "manual-summary.md", content: "# 手册总结\n\n- CPU: Cortex-A53\n- 存储: eMMC\n" },
            },
          ],
        })
      }
      expect((body.tools ?? []).map((tool) => tool.function?.name))
        .toEqual(expect.arrayContaining(["read", "write"]))
      return mockOpenAiStream({ content: "手册已读取并完成总结，文件已保存。" })
    },
  })

  try {
    const tools = new ToolRegistry()
    tools.register(writeTool)
    tools.register(readTool)
    const agents = new AgentRegistry()
    agents.registerAll(HIDDEN_AGENTS)
    const router = new ModelRouter([{
      id: "document-completion-model",
      name: "Document Completion Model",
      provider: "openai-compatible",
      modelId: "document-completion-model",
      apiKey: "test",
      baseUrl: `http://127.0.0.1:${server.port}`,
      capabilities: ["reasoning", "coding", "chat"],
      priority: 1,
      costFactor: 1,
      enabled: true,
      contextWindow: 32_000,
      maxOutputTokens: 2_048,
    }])
    SessionRepo.create({
      id: sessionId,
      title: "document completion",
      agent_id: "main-agent",
      project_path: root,
    })
    const snapshots: ExecutionSnapshot[] = []
    const events: Array<{ type: string; text?: string; message?: string }> = []
    const loop = new AgentLoop({ toolRegistry: tools, agentRegistry: agents, modelRouter: router }, 8)
    for await (const event of loop.run({
      sessionId,
      runId: sessionId,
      runType: "root",
      userMessage: "读取 manual.txt 并写入 manual-summary.md",
      agentId: "main-agent",
      workingDir: root,
      scope: "full-access",
      preferredModelId: "document-completion-model",
      modelFallbackEnabled: false,
      objectiveEffects: ["workspace-read", "workspace-write"],
      objectiveAcceptancePolicy: {
        requirements: [
          {
            id: "inspection",
            label: "读取手册",
            verifier: "workspace-inspection",
            anyOf: ["workspace-inspection"],
            targetPatterns: ["manual.txt"],
          },
          {
            id: "mutation",
            label: "写入总结",
            verifier: "mutation",
            anyOf: ["workspace-mutation"],
            targetPatterns: ["manual-summary.md"],
          },
        ],
      },
      executionState: { persist: (snapshot) => snapshots.push(snapshot) },
    })) events.push(event)

    expect(requests).toHaveLength(2)
    expect(requests[0]?.toolChoice).not.toBe("required")
    expect(requests[1]?.tools).toEqual(expect.arrayContaining(["read", "write"]))
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""))
      .toContain("完成总结")
    expect(snapshots.at(-1)?.state).toBe("completed")
    expect(snapshots.at(-1)?.runtimeObjectiveAccepted).toBe(true)
    expect(readFileSync(join(root, "manual-summary.md"), "utf8")).toContain("Cortex-A53")
  } finally {
    server.stop(true)
    SessionRepo.delete(sessionId)
    rmSync(root, { recursive: true, force: true })
  }
})

function mockOpenAiStream(input: {
  content?: string
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>
}): Response {
  const chunks: string[] = []
  if (input.toolCalls?.length) {
    input.toolCalls.forEach((call, index) => {
      chunks.push(`data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`)
    })
    chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`)
  } else {
    chunks.push(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: input.content ?? "" }, finish_reason: null }],
    })}\n\n`)
    chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
  }
  chunks.push("data: [DONE]\n\n")
  return new Response(chunks.join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}
