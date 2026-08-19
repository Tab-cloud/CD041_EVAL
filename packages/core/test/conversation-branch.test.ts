import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  SessionCommandBranchBusyError,
  SessionCommandRepo,
} from "../src/store/session-command.ts"
import { MessageRepo, SessionRepo } from "../src/store/repository.ts"

const sessions = new Set<string>()

afterEach(() => {
  for (const sessionId of sessions) SessionRepo.delete(sessionId)
  sessions.clear()
})

describe("durable conversation branch replacement", () => {
  test("atomically removes the old reply and is idempotent on request replay", () => {
    const sessionId = createSession()
    const firstRequestId = randomUUID()
    const editedRequestId = randomUUID()
    addMessage(sessionId, firstRequestId, "user", "first", 1)
    addMessage(sessionId, firstRequestId, "assistant", "first reply", 2)
    addMessage(sessionId, editedRequestId, "user", "old question", 3)
    addMessage(sessionId, editedRequestId, "assistant", "old reply", 4)
    SessionRepo.setCompact(sessionId, "old summary", { throughSeq: 4 })

    const replacementRequestId = randomUUID()
    const payload = JSON.stringify({
      sessionId,
      requestId: replacementRequestId,
      message: "edited question",
      branchFrom: { requestId: editedRequestId, seq: 3 },
    })
    const inserted = SessionCommandRepo.enqueue({
      sessionId,
      requestId: replacementRequestId,
      payload,
    })

    expect(inserted.inserted).toBe(true)
    expect(MessageRepo.getBySession(sessionId).map(({ content }) => content))
      .toEqual(["first", "first reply"])
    expect(SessionRepo.get(sessionId)?.compact_summary).toBeNull()

    addMessage(sessionId, replacementRequestId, "user", "edited question", 3)
    const duplicate = SessionCommandRepo.enqueue({
      sessionId,
      requestId: replacementRequestId,
      payload,
    })
    expect(duplicate.inserted).toBe(false)
    expect(MessageRepo.getBySession(sessionId).map(({ content }) => content))
      .toEqual(["first", "first reply", "edited question"])
  })

  test("keeps history intact while another command owns the session", () => {
    const sessionId = createSession()
    const editedRequestId = randomUUID()
    addMessage(sessionId, editedRequestId, "user", "question", 1)
    addMessage(sessionId, editedRequestId, "assistant", "reply", 2)
    const activeRequestId = randomUUID()
    SessionCommandRepo.enqueue({
      sessionId,
      requestId: activeRequestId,
      payload: JSON.stringify({ sessionId, requestId: activeRequestId, message: "active" }),
    })

    const replacementRequestId = randomUUID()
    expect(() => SessionCommandRepo.enqueue({
      sessionId,
      requestId: replacementRequestId,
      payload: JSON.stringify({
        sessionId,
        requestId: replacementRequestId,
        message: "edited",
        branchFrom: { requestId: editedRequestId, seq: 1 },
      }),
    })).toThrow(SessionCommandBranchBusyError)
    expect(MessageRepo.getBySession(sessionId).map(({ content }) => content))
      .toEqual(["question", "reply"])
  })
})

function createSession(): string {
  const sessionId = `conversation-branch-${randomUUID()}`
  SessionRepo.create({
    id: sessionId,
    title: "conversation branch test",
    agent_id: "main-agent",
    project_path: ".",
  })
  sessions.add(sessionId)
  return sessionId
}

function addMessage(
  sessionId: string,
  requestId: string,
  role: "user" | "assistant",
  content: string,
  seq: number,
): void {
  MessageRepo.create({
    session_id: sessionId,
    request_id: requestId,
    role,
    content,
    agent_id: null,
    tool_calls: null,
    tool_results: null,
    seq,
    timestamp: Date.now(),
  })
}
