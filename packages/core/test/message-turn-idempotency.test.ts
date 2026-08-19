import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { prepareSessionTurn } from "../src/runtime/server-chat-session.ts"
import { handleRequest } from "../src/runtime/server.ts"
import { MessageRepo, SessionRepo } from "../src/store/repository.ts"
import { SessionCommandRepo } from "../src/store/session-command.ts"

const sessions = new Set<string>()
const originalToken = process.env.EVAL_AGENT_TOKEN
const originalUnauthenticated = process.env.EVAL_ALLOW_UNAUTHENTICATED

afterEach(() => {
  for (const sessionId of sessions) SessionRepo.delete(sessionId)
  sessions.clear()
  restoreEnv("EVAL_AGENT_TOKEN", originalToken)
  restoreEnv("EVAL_ALLOW_UNAUTHENTICATED", originalUnauthenticated)
})

describe("request-bound conversation turns", () => {
  test("duplicate dispatcher turn preparation persists one user message", async () => {
    const sessionId = createSession()
    const requestId = `request-${randomUUID()}`
    const existingSession = SessionRepo.get(sessionId)

    await Promise.all(Array.from({ length: 16 }, async () => {
      prepareSessionTurn({
        existingSession,
        sessionId,
        requestId,
        message: "请读取附件并总结",
        agentId: "main-agent",
        workingDir: process.cwd(),
        effort: "on",
        requestedScope: "auto-edit",
        priorMessageRows: MessageRepo.getBySession(sessionId),
      })
    }))

    const rows = MessageRepo.getBySession(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      session_id: sessionId,
      request_id: requestId,
      role: "user",
      content: "请读取附件并总结",
    })
  })

  test("request identity deduplicates one role without merging distinct turns", () => {
    const sessionId = createSession()
    const firstRequestId = `request-${randomUUID()}`
    const secondRequestId = `request-${randomUUID()}`
    const create = (requestId: string) => MessageRepo.create({
      session_id: sessionId,
      request_id: requestId,
      role: "user",
      content: "相同文本仍可属于不同用户轮次",
      agent_id: "main-agent",
      tool_calls: null,
      tool_results: null,
      seq: MessageRepo.latestSeq(sessionId) + 1,
      timestamp: Date.now(),
    })

    const original = create(firstRequestId)
    const duplicate = create(firstRequestId)
    const distinct = create(secondRequestId)

    expect(duplicate.id).toBe(original.id)
    expect(distinct.id).not.toBe(original.id)
    expect(MessageRepo.getBySession(sessionId)).toHaveLength(2)
  })

  test("messages API exposes the durable request identity", async () => {
    const sessionId = createSession()
    const requestId = `request-${randomUUID()}`
    MessageRepo.create({
      session_id: sessionId,
      request_id: requestId,
      role: "user",
      content: "公开轮次",
      agent_id: "main-agent",
      tool_calls: null,
      tool_results: null,
      seq: 1,
      timestamp: Date.now(),
    })
    SessionCommandRepo.enqueue({
      requestId,
      sessionId,
      payload: JSON.stringify({
        message: "公开轮次",
        attachments: [{
          name: "kimi技术报告.pdf",
          size: 1024,
          kind: "binary",
          dataBase64: "不得公开",
        }],
      }),
    })
    delete process.env.EVAL_AGENT_TOKEN
    process.env.EVAL_ALLOW_UNAUTHENTICATED = "1"

    const response = await handleRequest(new Request(
      `http://localhost/api/messages?sessionId=${encodeURIComponent(sessionId)}`,
    ))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      expect.objectContaining({
        session_id: sessionId,
        requestId,
        role: "user",
        content: "公开轮次",
        attachments: [{
          name: "kimi技术报告.pdf",
          size: 1024,
          kind: "binary",
        }],
      }),
    ])
  })
})

function createSession(): string {
  const sessionId = `message-turn-${randomUUID()}`
  SessionRepo.create({
    id: sessionId,
    title: "turn idempotency",
    agent_id: "main-agent",
    project_path: null,
  })
  sessions.add(sessionId)
  return sessionId
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
