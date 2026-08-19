import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { SessionRepo } from "../src/store/repository.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"

test("semantic continuation binds one durable same-session lineage edge", () => {
  const sessionId = `continuation-lineage-${randomUUID()}`
  const otherSessionId = `continuation-lineage-other-${randomUUID()}`
  const parentId = `parent-${randomUUID()}`
  const childId = `child-${randomUUID()}`
  const otherId = `other-${randomUUID()}`
  const now = Date.now()

  SessionRepo.create({
    id: sessionId,
    title: "continuation lineage",
    agent_id: "main-agent",
    project_path: ".",
  })
  SessionRepo.create({
    id: otherSessionId,
    title: "other continuation lineage",
    agent_id: "main-agent",
    project_path: ".",
  })
  for (const task of [
    { id: parentId, sessionId, message: "阅读技术报告" },
    { id: childId, sessionId, message: "请继续详细拆解" },
    { id: otherId, sessionId: otherSessionId, message: "其他会话" },
  ]) {
    TaskRunRepo.create({
      id: task.id,
      sessionId: task.sessionId,
      agentId: "main-agent",
      priority: 10,
      status: "queued",
      message: task.message,
      workingDir: ".",
      type: "chat",
      createdAt: now,
    })
  }

  try {
    expect(TaskRunRepo.bindRetryOf(childId, parentId)).toBe(true)
    expect(TaskRunRepo.get(childId)?.retryOf).toBe(parentId)
    expect(TaskRunRepo.bindRetryOf(childId, otherId)).toBe(false)
    expect(TaskRunRepo.get(childId)?.retryOf).toBe(parentId)
    expect(TaskRunRepo.bindRetryOf(parentId, otherId)).toBe(false)
    expect(TaskRunRepo.bindRetryOf(parentId, parentId)).toBe(false)
  } finally {
    TaskRunRepo.deleteBySession(sessionId)
    TaskRunRepo.deleteBySession(otherSessionId)
    SessionRepo.delete(sessionId)
    SessionRepo.delete(otherSessionId)
  }
})
