import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { AgentRegistry } from "../src/agent/registry.ts"
import { ModelRouter } from "../src/model-router/index.ts"
import { AgentLoop } from "../src/runtime/agent-loop.ts"
import type { ExecutionSnapshot } from "../src/runtime/agent-loop-control.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { ToolRegistry } from "../src/tool/registry.ts"

test("a hard-bound model quota limit blocks with an actionable reason instead of failing", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-model-quota-blocker-"))
  const sessionId = `model-quota-blocker-${Date.now()}-${Math.random()}`
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++
      return new Response(JSON.stringify({
        error: {
          message: "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)",
          type: "rate_limit_error",
        },
      }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    },
  })

  try {
    const agents = new AgentRegistry()
    agents.registerAll(HIDDEN_AGENTS)
    const router = new ModelRouter([{
      id: "quota-selected",
      name: "Quota Selected",
      provider: "openai-compatible",
      modelId: "quota-selected",
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
      title: "quota blocker",
      agent_id: "main-agent",
      project_path: root,
    })

    const snapshots: ExecutionSnapshot[] = []
    const events: Array<Record<string, unknown>> = []
    const loop = new AgentLoop({
      toolRegistry: new ToolRegistry(),
      agentRegistry: agents,
      modelRouter: router,
    }, 4)
    for await (const event of loop.run({
      sessionId,
      runId: sessionId,
      runType: "root",
      userMessage: "继续解读已上传的技术报告",
      agentId: "main-agent",
      workingDir: root,
      preferredModelId: "quota-selected",
      modelFallbackEnabled: false,
      executionState: { persist: (snapshot) => snapshots.push(snapshot) },
    })) {
      events.push(event as unknown as Record<string, unknown>)
    }

    expect(requests).toBe(1)
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.find((event) => event.type === "execution-blocked")).toMatchObject({
      reason: "模型配额已耗尽，需等待额度恢复",
    })
    expect(snapshots.at(-1)).toMatchObject({
      state: "blocked",
      stopReason: "模型配额已耗尽，需等待额度恢复",
    })
  } finally {
    server.stop(true)
    SessionRepo.delete(sessionId)
    rmSync(root, { recursive: true, force: true })
  }
})

test("a hard-bound model reconnects before transient service failure becomes blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "eval-model-transient-blocker-"))
  const sessionId = `model-transient-blocker-${Date.now()}-${Math.random()}`
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++
      return Response.json({
        error: {
          message: "Service Unavailable",
          type: "server_error",
        },
      }, { status: 503 })
    },
  })

  try {
    const agents = new AgentRegistry()
    agents.registerAll(HIDDEN_AGENTS)
    const router = new ModelRouter([{
      id: "transient-selected",
      name: "Transient Selected",
      provider: "openai-compatible",
      modelId: "transient-selected",
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
      title: "transient blocker",
      agent_id: "main-agent",
      project_path: root,
    })

    const snapshots: ExecutionSnapshot[] = []
    const events: Array<Record<string, unknown>> = []
    const loop = new AgentLoop({
      toolRegistry: new ToolRegistry(),
      agentRegistry: agents,
      modelRouter: router,
    }, 4)
    for await (const event of loop.run({
      sessionId,
      runId: sessionId,
      runType: "root",
      userMessage: "继续解读已上传的技术报告",
      agentId: "main-agent",
      workingDir: root,
      preferredModelId: "transient-selected",
      modelFallbackEnabled: false,
      executionState: { persist: (snapshot) => snapshots.push(snapshot) },
    })) {
      events.push(event as unknown as Record<string, unknown>)
    }

    expect(requests).toBe(5)
    expect(events.filter((event) =>
      event.type === "model-attempt" && event.status === "reconnecting")).toHaveLength(4)
    expect(events.filter((event) =>
      event.type === "model-attempt" && event.status === "reconnecting")
      .map((event) => [event.attempt, event.maxAttempts, event.modelId]))
      .toEqual([
        [1, 4, "transient-selected"],
        [2, 4, "transient-selected"],
        [3, 4, "transient-selected"],
        [4, 4, "transient-selected"],
      ])
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.find((event) => event.type === "execution-blocked")).toMatchObject({
      reason: "模型服务暂时不可用",
    })
    expect(snapshots.at(-1)).toMatchObject({
      state: "blocked",
      stopReason: "模型服务暂时不可用",
    })
  } finally {
    server.stop(true)
    SessionRepo.delete(sessionId)
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
