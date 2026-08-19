import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { getDb } from "../src/store/database.ts"
import { RunEventRepo } from "../src/store/run-event.ts"
import { SessionCommandRepo } from "../src/store/session-command.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"
import { createRunEventEmitter } from "../src/runtime/server-chat-events.ts"
import { handleTaskRoutes } from "../src/runtime/server-tasks.ts"
import { commandSubscriptionResponse } from "../src/runtime/session-command-subscription.ts"
import { assistantPartsForRequest } from "../src/runtime/assistant-message-parts.ts"
import {
  projectPublicRunEvent,
  projectPublicRunEventRecords,
} from "../src/runtime/public-run-event.ts"
import type { RuntimeEventType } from "../src/runtime/runtime-protocol.ts"

const runIds = new Set<string>()
const sessionIds = new Set<string>()

afterEach(() => {
  for (const runId of runIds) RunEventRepo.deleteByRun(runId)
  for (const sessionId of sessionIds) SessionCommandRepo.deleteBySession(sessionId)
  runIds.clear()
  sessionIds.clear()
})

describe("public run event boundary", () => {
  test("projects rich control-plane objects into explicit public schemas", () => {
    const secret = "requirements-analyst:child-run:owner-token:lease-123"
    expect(projectPublicRunEvent("assistant-part", {
      requestId: "request-public", partId: "reasoning:1", partType: "reasoning",
      status: "delta", text: secret, timestamp: 1,
    })).toBeNull()
    expect(projectPublicRunEvent("assistant-part", {
      requestId: "request-public", partId: "reasoning:1", partType: "reasoning",
      status: "start", timestamp: 1,
    })).toEqual({
      type: "assistant-part",
      payload: {
        requestId: "request-public", partId: "reasoning:1", partType: "reasoning",
        status: "start", timestamp: 1,
      },
    })

    const task = projectPublicRunEvent("task-status", {
      id: "task-public",
      sessionId: "session-private",
      agentId: "requirements-analyst",
      status: "failed",
      type: "chat",
      message: "执行任务",
      error: `${secret}\nprivate stack`,
      createdAt: 1,
    })
    expect(task?.payload).toMatchObject({
      kind: "task-status",
      id: "task-public",
      status: "failed",
      problem: { kind: "problem", code: "runtime-failure" },
    })
    assertNoPrivateControlPlane(task?.payload, secret)

    const tool = projectPublicRunEvent("tool-execution", {
      id: "execution-public",
      sessionId: "session-private",
      runId: "child-run",
      toolCallId: "private-tool-call",
      toolName: "write",
      input: { content: secret, path: "src/main.ts" },
      status: "succeeded",
      filePath: "src/main.ts",
      diff: "+change",
      linesAdded: 1,
      linesRemoved: 0,
      reversible: true,
      startedAt: 2,
    })
    expect(tool?.payload).toEqual({
      kind: "tool-execution",
      id: "execution-public",
      toolName: "write",
      status: "succeeded",
      filePath: "src/main.ts",
      diff: "+change",
      linesAdded: 1,
      linesRemoved: 0,
      reversible: true,
      startedAt: 2,
    })
    assertNoPrivateControlPlane(tool?.payload, secret)

    const approval = projectPublicRunEvent("approval-request", {
      id: "approval-public",
      sessionId: "session-private",
      runId: "child-run",
      parentRunId: "root-run",
      toolCallId: "private-tool-call",
      toolName: "bash",
      input: { command: secret, ownerToken: secret },
      reason: secret,
      target: secret,
      createdAt: 3,
      expiresAt: 4,
    })
    expect(approval?.payload).toEqual({
      kind: "approval",
      id: "approval-public",
      toolName: "bash",
      reason: "执行 bash 操作需要你的批准。",
      target: "当前工作空间",
      createdAt: 3,
      expiresAt: 4,
    })
    assertNoPrivateControlPlane(approval?.payload, secret)

    const error = projectPublicRunEvent("error", { message: secret, stack: secret })
    expect(error?.payload).toMatchObject({
      kind: "problem",
      code: "runtime-failure",
      retryable: true,
    })
    assertNoPrivateControlPlane(error?.payload, secret)
  })

  test("projects model quota exhaustion as an actionable blocker without provider payloads", () => {
    const raw = "HTTP 429: 已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"
    const blocked = projectPublicRunEvent("execution-blocked", { reason: raw })
    expect(blocked?.payload).toEqual({
      kind: "problem",
      code: "model-quota-exhausted",
      message: "所选模型的配额已耗尽。请切换模型或补充额度后重试。",
      diagnosticId: expect.any(String),
      retryable: true,
    })
    expect(JSON.stringify(blocked)).not.toContain("Token Plan")
    expect(JSON.stringify(blocked)).not.toContain("2056")
  })

  test("every declared event type has an explicit allowlist and unknown events fail closed", () => {
    const secret = "private-agent:owner-token:reasoning-content"
    const now = Date.now()
    const fixtures = {
      heartbeat: { timestamp: now, ownerToken: secret },
      session: { sessionId: "session-public", taskId: "task-public", ownerToken: secret },
      "task-status": {
        id: "task-public", type: "chat", status: "running", message: "执行中",
        createdAt: now, agentId: secret,
      },
      "graph-event": { graphId: "graph-public", version: 1, createdAt: now, payload: { agentId: secret } },
      "serial-context": { port: "COM3", baudRate: 115200, lineCount: 2, raw: secret },
      "context-compaction": {
        status: "complete", used: 10, total: 100, ratio: 0.1, threshold: 0.8,
        message: "压缩完成", breakdown: { messages: 10 }, protocolMessages: { used: 2, total: 100 },
        summary: { content: "公共摘要", timestamp: now }, reasoningContent: secret,
      },
      "execution-state": {
        state: "running",
        todos: [{ content: "验证", status: "in_progress", priority: "high", evidence: [secret], assignee: secret }],
        followups: [{ content: "连接硬件", owner: "user", category: "hardware-validation", internal: secret }],
        updatedAt: now,
        ownerToken: secret,
      },
      "assistant-part": {
        requestId: "request-public", partId: "text:1", partType: "text",
        status: "delta", text: "面向用户的回复", timestamp: now, reasoningContent: secret,
      },
      "tool-call": { name: "read", input: { path: "README.md", ownerToken: secret }, toolCallId: secret },
      "tool-result": { id: "result-public", name: "read", result: { status: "ok", ownerToken: secret } },
      "tool-status": { id: "tool-public", name: "read", status: "running", input: { path: "README.md", ownerToken: secret } },
      "context-capacity": {
        used: 10, total: 100, breakdown: { messages: 10 },
        protocolMessages: { used: 2, total: 100 }, usage: { promptTokens: 10, completionTokens: 2 },
        source: "model", ownerToken: secret,
      },
      "model-routed": {
        modelId: "model-public", modelName: "Model", attempt: 1, failureReason: secret,
        sessionId: secret,
      },
      "model-attempt": {
        attemptId: "attempt-public", operation: "vision", attempt: 1, modelId: "model-public",
        modelName: "Model", status: "failed", failureReason: secret, runId: secret,
      },
      "tool-stream": { target: "build", name: "compile", text: "BUILD OK", type: "stdout", runId: secret },
      "plan-submitted": { contract: secret },
      "question-request": {
        id: "question-public", question: "请选择", options: ["A"], createdAt: now,
        runId: secret, toolCallId: secret,
      },
      "question-resolved": { questionId: "question-public", answer: secret },
      "approval-request": {
        id: "approval-public", toolName: "write", input: { path: "src/main.ts", ownerToken: secret },
        reason: secret, createdAt: now, expiresAt: now + 1_000, runId: secret,
      },
      "approval-resolved": { approvalId: "approval-public", outcome: "approved", decidedBy: secret },
      "tool-execution": {
        id: "execution-public", toolName: "write", status: "succeeded", filePath: "src/main.ts",
        diff: "+change", linesAdded: 1, linesRemoved: 0, reversible: true, startedAt: now,
        input: { ownerToken: secret }, runId: secret,
      },
      "agent-activity": {
        runId: secret, sessionId: secret, agentId: secret, agentName: "主 Agent",
        state: "executing", activity: "正在验证", timestamp: now,
      },
      "agent-progress": { phase: "tools", step: 2, maxSteps: 4, toolCount: 1, runId: secret },
      "execution-stopped": {
        reason: "任务已暂停", outstandingTodos: 1,
        outstandingSummary: { runnableTodos: 1, verificationGaps: 0, acceptanceGaps: 0, total: 1 },
        ownerToken: secret,
      },
      "execution-continued": { segment: 2, outstandingTodos: 1, ownerToken: secret },
      "execution-blocked": { reason: "等待外部条件", rawError: secret },
      "execution-phase": { phase: "execution", scope: "auto-edit", ownerToken: secret },
      "artifact-updated": { revision: 2, artifact: { model: secret, sessionId: secret } },
      error: { message: secret, stack: secret },
      done: { requestId: "request-public", taskId: "task-public", status: "failed", error: secret, sessionId: secret },
    } satisfies Record<RuntimeEventType, unknown>

    for (const [type, payload] of Object.entries(fixtures) as Array<[RuntimeEventType, unknown]>) {
      const projected = projectPublicRunEvent(type, payload)
      expect(projected).not.toBeNull()
      assertNoPrivateControlPlane(
        projected?.payload,
        secret,
        type === "session" ? new Set(["sessionId"]) : undefined,
      )
    }
    expect(projectPublicRunEvent("private-control-event" as RuntimeEventType, { text: secret })).toBeNull()
  })

  test("SSE and durable history receive the exact same projected events", () => {
    const { runId, sessionId } = trackedIds()
    const requestId = `request-${randomUUID()}`
    const chunks: Uint8Array[] = []
    const emit = createRunEventEmitter({
      controller: { enqueue: (chunk) => chunks.push(chunk) },
      runId,
      sessionId,
      requestId,
      agentId: "main-agent",
      isSseAborted: () => false,
    })
    const secret = "child-run:lease:raw-thinking"

    const part = { partId: "reasoning:1", partType: "reasoning", timestamp: 1 }
    emit("assistant-part", { ...part, status: "start" })
    emit("assistant-part", { ...part, status: "delta", text: "公开推理摘要" })
    emit("assistant-part", { ...part, status: "delta", text: secret })
    emit("assistant-part", { ...part, status: "end", outcome: "completed", timestamp: 2 })
    emit("task-status", {
      id: "task-public", sessionId, agentId: "private-agent", status: "running",
      type: "chat", message: "执行中", createdAt: 1,
    })
    emit("tool-execution", {
      id: "execution-public", sessionId, runId, toolCallId: "private-call",
      toolName: "read", input: { path: "secret.c" }, status: "succeeded",
      linesAdded: 0, linesRemoved: 0, reversible: false, startedAt: 2,
    })
    emit("error", { message: secret })
    emit("done", { sessionId, taskId: runId, status: "failed", error: secret })

    const sse = parseSse(chunks)
    const stored = RunEventRepo.listAfter(runId).map((event) => ({
      id: event.seq,
      type: event.type,
      data: event.payload,
    }))
    expect(sse).toEqual(stored)
    expect(stored.map((event) => event.type)).toEqual([
      "assistant-part", "assistant-part", "assistant-part", "task-status", "tool-execution", "error", "done",
    ])
    expect(stored.at(-1)?.data).toMatchObject({
      kind: "done",
      requestId,
      taskId: runId,
      status: "failed",
    })
    expect(JSON.stringify(stored)).not.toContain(secret)
    for (const event of stored) assertNoPrivateControlPlane(event.data)
  })

  test("message restore rebuilds reasoning duration from durable typed parts", () => {
    const { runId, sessionId } = trackedIds()
    const requestId = `request-${randomUUID()}`
    SessionCommandRepo.enqueue({ requestId, sessionId, payload: JSON.stringify({ message: "test" }) })
    getDb().run(
      "UPDATE session_commands SET state = 'completed', task_id = ?, completed_at = ? WHERE request_id = ?",
      [runId, Date.now(), requestId],
    )
    const emit = createRunEventEmitter({
      controller: { enqueue: () => undefined },
      runId,
      sessionId,
      requestId,
      agentId: "main-agent",
      isSseAborted: () => false,
    })
    const part = { partId: "reasoning:attempt-1:0", partType: "reasoning" }
    emit("assistant-part", { ...part, status: "start", timestamp: 1_000 })
    emit("assistant-part", { ...part, status: "delta", text: "推理摘要", timestamp: 27_500 })
    emit("assistant-part", { ...part, status: "end", outcome: "completed", timestamp: 27_600 })

    expect(assistantPartsForRequest(requestId)).toEqual([expect.objectContaining({
      id: part.partId,
      type: "reasoning",
      text: "推理摘要",
      state: "completed",
      startedAt: 1_000,
      endedAt: 27_600,
    })])
  })

  test("legacy durable events are projected again before command replay", async () => {
    const { runId, sessionId } = trackedIds()
    const requestId = `request-${randomUUID()}`
    SessionCommandRepo.enqueue({
      requestId,
      sessionId,
      payload: JSON.stringify({ message: "test" }),
    })
    getDb().run(
      "UPDATE session_commands SET state = 'completed', task_id = ?, completed_at = ? WHERE request_id = ?",
      [runId, Date.now(), requestId],
    )
    const secret = "hardware-engineer:child-run:owner-token:lease-raw"
    RunEventRepo.append(runId, sessionId, "thinking" as RuntimeEventType, { status: "delta", text: secret })
    RunEventRepo.append(runId, sessionId, "tool-execution", {
      id: "legacy-execution",
      sessionId,
      runId,
      parentRunId: "root-run",
      toolCallId: "private-call",
      toolName: "write",
      input: { content: secret },
      status: "succeeded",
      filePath: "src/legacy.ts",
      diff: "+legacy",
      linesAdded: 1,
      linesRemoved: 0,
      reversible: true,
      startedAt: 1,
    })
    RunEventRepo.append(runId, sessionId, "error", { message: secret, stack: secret })
    RunEventRepo.append(runId, sessionId, "done", {
      sessionId,
      taskId: runId,
      status: "failed",
      error: secret,
    })

    const response = commandSubscriptionResponse(requestId, sessionId, {})
    const text = await response.text()
    expect(text).not.toContain("event: thinking")
    expect(text).toContain("event: tool-execution")
    expect(text).toContain("event: error")
    expect(text).toContain("event: done")
    expect(text).toContain(`"requestId":"${requestId}"`)
    expect(text).not.toContain(secret)
    expect(text).not.toContain("private-call")
    const replayedPublicEvents = text.split("\n\n")
      .filter((frame) => frame && !frame.includes("event: session"))
      .join("\n\n")
    expect(replayedPublicEvents).not.toContain(`"sessionId"`)
    expect(replayedPublicEvents).not.toContain(`"runId"`)

    const records = projectPublicRunEventRecords(RunEventRepo.listAfter(runId))
    expect(records.every((event) => !("runId" in event) && !("sessionId" in event))).toBe(true)
    expect(JSON.stringify(records)).not.toContain(secret)
    expect(records.map((event) => event.type)).toEqual(["tool-execution", "error", "done"])
  })

  test("HTTP task and command snapshots reuse sanitized public problem views", async () => {
    const { runId, sessionId } = trackedIds()
    const requestId = `request-${randomUUID()}`
    const secret = "child-agent:owner-token:private-stack-and-result"
    SessionRepo.create({
      id: sessionId,
      title: "public HTTP boundary",
      agent_id: "main-agent",
      project_path: ".",
    })
    TaskRunRepo.create({
      id: runId,
      requestId,
      sessionId,
      agentId: "private-child",
      priority: 8,
      status: "failed",
      message: "公开任务",
      workingDir: "C:/private/workspace",
      type: "chat",
      result: secret,
      error: secret,
      createdAt: Date.now(),
      completedAt: Date.now(),
    })
    SessionCommandRepo.enqueue({
      requestId,
      sessionId,
      payload: JSON.stringify({ sessionId, requestId, message: "公开任务" }),
    })
    SessionCommandRepo.finish(requestId, "failed", secret)

    try {
      const taskResponse = await handleTaskRoutes(
        new Request(`http://eval.local/api/tasks/status?id=${runId}`),
        new URL(`http://eval.local/api/tasks/status?id=${runId}`),
        {},
      )
      const taskText = await taskResponse!.text()
      expect(taskText).not.toContain(secret)
      expect(taskText).not.toContain("private-child")
      expect(taskText).not.toContain("C:/private/workspace")
      expect(taskText).not.toContain('"result"')
      expect(taskText).not.toContain('"error"')
      expect(taskText).toContain('"problem"')

      const commandResponse = await handleTaskRoutes(
        new Request(`http://eval.local/api/session-commands?requestId=${requestId}`),
        new URL(`http://eval.local/api/session-commands?requestId=${requestId}`),
        {},
      )
      const commandText = await commandResponse!.text()
      expect(commandText).not.toContain(secret)
      expect(commandText).not.toContain('"error"')
      expect(commandText).toContain('"problem"')
    } finally {
      TaskRunRepo.deleteBySession(sessionId)
      SessionRepo.delete(sessionId)
    }
  })
})

function trackedIds() {
  const runId = `public-run-${randomUUID()}`
  const sessionId = `public-session-${randomUUID()}`
  runIds.add(runId)
  sessionIds.add(sessionId)
  return { runId, sessionId }
}

function parseSse(chunks: Uint8Array[]) {
  const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")
  return text.trim().split("\n\n").filter(Boolean).map((frame) => {
    const lines = frame.split("\n")
    return {
      id: Number(lines.find((line) => line.startsWith("id: "))?.slice(4)),
      type: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null"),
    }
  })
}

function assertNoPrivateControlPlane(
  value: unknown,
  sentinel?: string,
  allowedKeys = new Set<string>(),
): void {
  const forbidden = new Set([
    "sessionId", "runId", "parentRunId", "agentId", "toolCallId", "input",
    "ownerToken", "ownerEpoch", "leaseId",
  ])
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== "object") return
    for (const [key, nested] of Object.entries(candidate)) {
      expect(forbidden.has(key) && !allowedKeys.has(key)).toBe(false)
      visit(nested)
    }
  }
  visit(value)
  if (sentinel) expect(JSON.stringify(value)).not.toContain(sentinel)
}
