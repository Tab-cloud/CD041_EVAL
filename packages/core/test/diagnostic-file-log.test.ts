import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { flushDiagnosticFileLog } from "../src/runtime/diagnostic-file-log.ts"
import { logOrchestrationEvent } from "../src/runtime/orchestration-log.ts"
import { LLMManager } from "../src/runtime/llm-manager.ts"
import type { ModelConfig } from "../src/model-router/types.ts"
import { EVAL_DIAGNOSTIC_LOG_PATH } from "../src/store/runtime-data-paths.ts"

describe("diagnostic log.txt sink", () => {
  test("mirrors structured orchestration events and redacts sensitive fields", async () => {
    const requestId = `diagnostic-request-${randomUUID()}`
    const secret = `secret-${randomUUID()}`
    logOrchestrationEvent({
      sessionId: `diagnostic-session-${randomUUID()}`,
      runId: `diagnostic-run-${randomUUID()}`,
      agentId: "main-agent",
      eventType: "test.blocked-replay",
      level: "warning",
      message: "验证阻塞事件回放",
      data: {
        requestId,
        projectionVersion: 1,
        problemCode: "model-quota-exhausted",
        password: secret,
      },
    })

    await flushDiagnosticFileLog()
    const text = await readFile(EVAL_DIAGNOSTIC_LOG_PATH, "utf8")
    const matching = text.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.eventType === "test.blocked-replay"
        && JSON.stringify(entry).includes(requestId))

    expect(EVAL_DIAGNOSTIC_LOG_PATH.endsWith("log.txt")).toBe(true)
    expect(matching).toMatchObject({
      version: 1,
      level: "warning",
      eventType: "test.blocked-replay",
      message: "验证阻塞事件回放",
      data: {
        requestId,
        projectionVersion: 1,
        problemCode: "model-quota-exhausted",
        password: "[已隐藏]",
      },
    })
    expect(JSON.stringify(matching)).not.toContain(secret)
  })

  test("mirrors model attempt lifecycle with failure kind and latency", async () => {
    const manager = new LLMManager()
    const runId = `diagnostic-model-run-${randomUUID()}`
    const model: ModelConfig = {
      id: "diagnostic-model",
      name: "Diagnostic Model",
      provider: "openai-compatible",
      modelId: "diagnostic-model",
      baseUrl: `https://diagnostic-${randomUUID()}.example.test/v1`,
      capabilities: ["chat"],
      priority: 1,
      costFactor: 1,
      enabled: true,
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
    }
    const attempt = manager.startModelAttempt({
      runId,
      sessionId: `diagnostic-model-session-${randomUUID()}`,
      agentId: "main-agent",
      scope: "agent",
      operation: "root",
      segment: 0,
      step: 0,
      attempt: 1,
    }, model)
    manager.finishModelAttempt(attempt.id, "failed", "HTTP 503 Service Unavailable")

    await flushDiagnosticFileLog()
    const entries = (await readFile(EVAL_DIAGNOSTIC_LOG_PATH, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((entry) => entry.runId === runId)

    expect(entries.map((entry) => entry.eventType)).toEqual([
      "model-attempt.running",
      "model-attempt.failed",
    ])
    expect(entries.at(-1)).toMatchObject({
      level: "error",
      data: {
        attemptId: attempt.id,
        scope: "agent",
        failureKind: "fault-domain",
        status: "failed",
      },
    })
    expect(Number(entries.at(-1)?.data?.latency)).toBeGreaterThanOrEqual(0)
  })
})
