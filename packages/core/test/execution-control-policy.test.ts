import { expect, test } from "bun:test"
import {
  ExecutionController,
  type ToolExecutionOutcome,
} from "../src/runtime/agent-loop-control.ts"
import {
  LightweightExecutionControlPolicy,
} from "../src/runtime/execution-control-policy.ts"
import { resolveOutstandingWorkToolPolicy } from "../src/runtime/recovery-tool-policy.ts"

test("only an explicit unsatisfied phase contract makes post-mutation inspection blocking", () => {
  const policy = new LightweightExecutionControlPolicy()

  expect(policy.verificationGapIsBlocking({
    hasAcceptancePolicy: true,
    objectiveAccepted: true,
    mutationVerificationPending: true,
  })).toBe(false)
  expect(policy.verificationGapIsBlocking({
    hasAcceptancePolicy: true,
    objectiveAccepted: false,
    mutationVerificationPending: true,
  })).toBe(true)
  expect(policy.verificationGapIsBlocking({
    hasAcceptancePolicy: false,
    objectiveAccepted: false,
    mutationVerificationPending: true,
  })).toBe(false)
})

test("recovery and phase metadata remain advisory to the model", () => {
  const policy = new LightweightExecutionControlPolicy()

  expect(policy.requiresNativeTool({
    activeRecovery: false,
    requiredPhaseToolPending: false,
    consecutiveNoProgress: 2,
    outstandingWorkCount: 1,
  })).toBe(false)
  expect(policy.requiresNativeTool({
    activeRecovery: false,
    requiredPhaseToolPending: false,
    consecutiveNoProgress: 2,
    outstandingWorkCount: 0,
  })).toBe(false)
  expect(policy.requiresNativeTool({
    activeRecovery: true,
    requiredPhaseToolPending: false,
    consecutiveNoProgress: 0,
    outstandingWorkCount: 1,
  })).toBe(false)
  expect(policy.requiresNativeTool({
    activeRecovery: false,
    requiredPhaseToolPending: true,
    consecutiveNoProgress: 1,
    outstandingWorkCount: 1,
  })).toBe(false)
})

test("successful no-progress tool rounds remain model feedback rather than terminal failures", () => {
  const policy = new LightweightExecutionControlPolicy()

  expect(policy.successfulToolStagnationIsTerminal({ consecutiveNoProgress: 3 })).toBe(false)
  expect(policy.successfulToolStagnationIsTerminal({ consecutiveNoProgress: 30 })).toBe(false)
})

test("outstanding evidence advice keeps the complete authorized tool surface", () => {
  const tools = [
    { name: "read", description: "read", parameters: {}, progressRole: "inspection" as const },
    { name: "write", description: "write", parameters: {}, progressRole: "mutation" as const },
    { name: "todowrite", description: "todo", parameters: {}, progressRole: "control" as const },
  ]
  const mutation = resolveOutstandingWorkToolPolicy(tools, ["mutation"])
  expect(mutation.requireTool).toBe(false)
  expect(mutation.tools.map((tool) => tool.name)).toEqual(["read", "write", "todowrite"])

  const inspectionAndMutation = resolveOutstandingWorkToolPolicy(
    tools,
    ["workspace-inspection", "mutation"],
  )
  expect(inspectionAndMutation.tools.map((tool) => tool.name)).toEqual(["read", "write", "todowrite"])

  const unavailableBuildVerifier = resolveOutstandingWorkToolPolicy(
    tools.filter((tool) => tool.name !== "write"),
    ["build"],
  )
  expect(unavailableBuildVerifier.requireTool).toBe(false)
  expect(unavailableBuildVerifier.tools.map((tool) => tool.name)).toEqual(["read", "todowrite"])
})

test("control-plane progress committed during a tool batch is not counted as stagnation", () => {
  const controller = new ExecutionController(8, 20, 60_000)
  controller.updateTodos({
    todos: [{ content: "生成手册总结", status: "in_progress", priority: "high" }],
  })
  const progressRevisionBefore = controller.snapshot().progressRevision ?? 0
  controller.updateTodos({
    todos: [{
      content: "生成手册总结",
      status: "completed",
      priority: "high",
      acceptance: "总结文件已写入工作区",
    }],
  })

  const todoOutcome: ToolExecutionOutcome = {
    name: "todowrite",
    input: { todos: [] },
    result: { success: true, data: { todos: [] } },
    semantics: {
      mutation: false,
      verification: false,
      mutationTargets: [],
      verificationTargets: [],
      globalVerification: false,
    },
  }
  controller.observe([todoOutcome], { progressRevisionBefore })

  expect(controller.snapshot().consecutiveNoProgress).toBe(0)
})
