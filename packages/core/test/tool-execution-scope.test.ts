import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { SessionRepo } from "../src/store/repository.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"
import { ToolExecutionRepo } from "../src/store/tool-execution.ts"

test("tool activity queries one root tree instead of aggregating the whole session", () => {
  const sessionId = `tool-scope-${randomUUID()}`
  const oldRootId = `task-${randomUUID()}`
  const currentRootId = `task-${randomUUID()}`
  const childId = `task-${randomUUID()}`
  SessionRepo.create({
    id: sessionId,
    title: "tool scope",
    agent_id: "main-agent",
    project_path: ".",
  })
  try {
    for (const task of [
      { id: oldRootId, parentRunId: undefined },
      { id: currentRootId, parentRunId: undefined },
      { id: childId, parentRunId: currentRootId },
    ]) {
      TaskRunRepo.create({
        id: task.id,
        parentRunId: task.parentRunId,
        sessionId,
        agentId: task.parentRunId ? "build-agent" : "main-agent",
        priority: 5,
        status: "running",
        message: "test",
        workingDir: ".",
        type: "chat",
        createdAt: Date.now(),
      })
    }
    const old = ToolExecutionRepo.start({
      sessionId,
      runId: oldRootId,
      toolCallId: `call-${randomUUID()}`,
      agentId: "main-agent",
      toolName: "read",
      toolInput: { paths: ["old.txt"] },
      workingDir: ".",
    })
    const current = ToolExecutionRepo.start({
      sessionId,
      runId: currentRootId,
      toolCallId: `call-${randomUUID()}`,
      agentId: "main-agent",
      toolName: "read",
      toolInput: { paths: ["current.txt"] },
      workingDir: ".",
    })
    const child = ToolExecutionRepo.start({
      sessionId,
      runId: childId,
      parentRunId: currentRootId,
      toolCallId: `call-${randomUUID()}`,
      agentId: "build-agent",
      toolName: "write",
      toolInput: { path: "result.txt", content: "done" },
      workingDir: ".",
    })

    expect(ToolExecutionRepo.listByRootRun(sessionId, currentRootId).map((item) => item.id))
      .toEqual([current.id, child.id])
    expect(ToolExecutionRepo.listByRootRun(sessionId, oldRootId).map((item) => item.id))
      .toEqual([old.id])
  } finally {
    SessionRepo.delete(sessionId)
  }
})
