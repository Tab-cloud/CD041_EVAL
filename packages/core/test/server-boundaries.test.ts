import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { handleRequest } from "../src/runtime/server.ts"
import { BuildLogRepo } from "../src/store/build-log.ts"
import { RunEventRepo } from "../src/store/run-event.ts"
import { createRunEventEmitter } from "../src/runtime/server-chat-events.ts"
import {
  getCors,
  hasValidToken,
  isAllowedOrigin,
} from "../src/runtime/server-security.ts"

const originalToken = process.env.EVAL_AGENT_TOKEN
const originalUnauthenticated = process.env.EVAL_ALLOW_UNAUTHENTICATED
const originalOrigins = process.env.EVAL_ALLOWED_ORIGINS

afterEach(() => {
  restoreEnv("EVAL_AGENT_TOKEN", originalToken)
  restoreEnv("EVAL_ALLOW_UNAUTHENTICATED", originalUnauthenticated)
  restoreEnv("EVAL_ALLOWED_ORIGINS", originalOrigins)
})

describe("server route boundaries", () => {
  test("security boundary preserves allowlisted CORS and token checks", () => {
    process.env.EVAL_AGENT_TOKEN = "boundary-secret"
    delete process.env.EVAL_ALLOW_UNAUTHENTICATED

    const allowed = new Request("http://localhost/api/health", {
      headers: {
        origin: "tauri://localhost",
        "x-eval-agent-token": "boundary-secret",
      },
    })
    expect(isAllowedOrigin(allowed)).toBe(true)
    expect(hasValidToken(allowed)).toBe(true)
    expect(getCors(allowed)["Access-Control-Allow-Origin"])
      .toBe("tauri://localhost")

    const denied = new Request("http://localhost/api/health", {
      headers: {
        origin: "https://untrusted.invalid",
        "x-eval-agent-token": "wrong",
      },
    })
    expect(isAllowedOrigin(denied)).toBe(false)
    expect(hasValidToken(denied)).toBe(false)
    expect(getCors(denied)["Access-Control-Allow-Origin"]).toBeUndefined()
  })

  test("health and diagnostics routes retain their public response contracts", async () => {
    process.env.EVAL_AGENT_TOKEN = "route-secret"
    delete process.env.EVAL_ALLOW_UNAUTHENTICATED
    const headers = {
      origin: "tauri://localhost",
      "x-eval-agent-token": "route-secret",
    }

    const health = await handleRequest(
      new Request("http://localhost/api/health", { headers }),
    )
    expect(health.status).toBe(200)
    expect(health.headers.get("Access-Control-Allow-Origin"))
      .toBe("tauri://localhost")
    expect(await health.json()).toMatchObject({
      status: "ok",
      tools: 0,
      agents: 0,
    })

    const diagnostics = await handleRequest(
      new Request("http://localhost/api/diagnostics/report", { headers }),
    )
    expect(diagnostics.status).toBe(200)
    expect(await diagnostics.json()).toMatchObject({
      health: { status: "ok", tools: 0, agents: 0 },
      runtime: { platform: process.platform },
    })
  })

  test("router rejects a disallowed origin before dispatch", async () => {
    process.env.EVAL_AGENT_TOKEN = "route-secret"
    const response = await handleRequest(new Request(
      "http://localhost/api/health",
      {
        headers: {
          origin: "https://untrusted.invalid",
          "x-eval-agent-token": "route-secret",
        },
      },
    ))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Origin 不允许" })
  })

  test("chat events remain durable after the subscriber disconnects", () => {
    const runId = `boundary-${randomUUID()}`
    const sessionId = `boundary-${randomUUID()}`
    const chunks: Uint8Array[] = []
    let disconnected = false
    const emit = createRunEventEmitter({
      controller: { enqueue: (chunk) => chunks.push(chunk) },
      runId,
      sessionId,
      agentId: "main-agent",
      isSseAborted: () => disconnected,
    })

    try {
      emit("heartbeat", { timestamp: 1 })
      emit("tool-stream", { target: "build", text: "CC main.c", type: "stdout" })
      disconnected = true
      emit("done", { status: "completed" })

      const frames = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")
      expect(frames).toContain("event: heartbeat")
      expect(frames).toContain("id: 1\nevent: tool-stream")
      expect(frames).not.toContain("event: done")
      expect(RunEventRepo.listAfter(runId).map((event) => event.type))
        .toEqual(["tool-stream", "done"])
      expect(BuildLogRepo.listBySession(sessionId).map((event) => event.payload))
        .toEqual([{ target: "build", text: "CC main.c", type: "stdout" }])
    } finally {
      BuildLogRepo.deleteBySession(sessionId)
      RunEventRepo.deleteByRun(runId)
    }
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
