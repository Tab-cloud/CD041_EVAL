import { describe, expect, test } from "bun:test"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { executeDelegationDag } from "../src/runtime/delegation-dag.ts"
import { TaskScheduler } from "../src/runtime/task-scheduler.ts"
import {
  artifactReferencesFromExecutions,
  expectedOutputsSatisfied,
} from "../src/runtime/run-contract.ts"
import { delegateDagTool } from "../src/tool/general/delegate-dag.ts"
import { taskTool } from "../src/tool/general/task.ts"

describe("multi-Agent ownership invariants", () => {
  test("every orchestration tool requires both root runType and the main identity", async () => {
    const contexts = [
      { agentId: "main-agent" },
      { agentId: "main-agent", runType: "subagent" },
      { agentId: "firmware-engineer", runType: "root" },
    ]
    const calls = [
      (context: any) => taskTool.execute({
        subagent_name: "explore",
        description: "attempt peer delegation",
        prompt: "must never start",
      }, context),
      (context: any) => delegateDagTool.execute({
        nodes: [{
          id: "forbidden",
          description: "must never start",
          subagent: "explore",
          acceptance: ["must be rejected at identity gate"],
        }],
      }, context),
    ]

    for (const call of calls) {
      for (const partial of contexts) {
        const result = await call({
          sessionId: "redteam-session",
          workingDir: process.cwd(),
          ...partial,
        })
        expect(result.success).toBe(false)
        expect(result.error).toContain("主 Agent")
      }
    }
  })

  test("non-primary Agent capability manifests do not advertise orchestration tools", () => {
    for (const agent of HIDDEN_AGENTS.filter((candidate) => candidate.mode !== "primary")) {
      expect(agent.tools, `${agent.id} must not advertise task`).not.toContain("task")
      expect(agent.tools, `${agent.id} must not advertise delegate_dag`).not.toContain("delegate_dag")
      expect(agent.tools, `${agent.id} must not advertise task_review`).not.toContain("task_review")
    }
  })

  test("a parent cannot become completed while a descendant worker is still cancelling", () => {
    const scheduler = new TaskScheduler(2)
    const parent = scheduler.enqueue({
      sessionId: "redteam-session",
      agentId: "main-agent",
      priority: 8,
      type: "chat",
      message: "root",
      workingDir: process.cwd(),
    })
    const child = scheduler.enqueue({
      parentRunId: parent.id,
      sessionId: parent.sessionId,
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "non-cooperative child",
      workingDir: process.cwd(),
      laneKey: `child:${parent.id}`,
      resourceClaims: { reads: [], writes: ["src/shared.ts"] },
      onCancel: () => {},
    })
    expect(child.status).toBe("running")

    scheduler.cancelDescendants(parent.id)
    expect(child.status).toBe("cancelling")
    scheduler.completeTask(parent.id, "must wait")

    expect(parent.status).not.toBe("completed")
    expect(scheduler.getTask(parent.id)?.status).not.toBe("completed")
  })

  test("a failed tool execution cannot satisfy an expected output artifact", () => {
    const artifacts = artifactReferencesFromExecutions([{
      id: "failed-write",
      status: "failed",
      toolName: "write",
      filePath: "dist/firmware.hex",
      startedAt: Date.now(),
    } as any])

    expect(expectedOutputsSatisfied(["dist/firmware.hex"], artifacts)).toBe(false)
  })

  test("a failed DAG branch preserves an independent completed sibling", async () => {
    const cancelled: string[] = []
    const result = await executeDelegationDag([
      {
        id: "completed-sibling",
        dependsOn: [],
        resources: { reads: [], writes: ["src/a.ts"] },
        payload: { delayMs: 1 },
      },
      {
        id: "failed-sibling",
        dependsOn: [],
        resources: { reads: [], writes: ["src/b.ts"] },
        payload: { delayMs: 15 },
      },
    ], {
      suspendParent: () => true,
      resumeParent: async () => {},
      runNode: async (node) => {
        await new Promise((resolve) => setTimeout(resolve, node.payload.delayMs))
        return node.id === "failed-sibling"
          ? { nodeId: node.id, success: false, error: "injected failure" }
          : {
              nodeId: node.id,
              success: true,
              value: { status: "completed", runId: "completed-run" },
            }
      },
      cancelNode: (nodeId) => {
        cancelled.push(nodeId)
        return "exited"
      },
    })

    expect(result.success).toBe(false)
    expect(cancelled).toEqual([])
    const completed = result.results.find((item) => item.nodeId === "completed-sibling")
    expect(completed?.success).toBe(true)
    expect(completed?.value).toMatchObject({ status: "completed", runId: "completed-run" })
  })
})
