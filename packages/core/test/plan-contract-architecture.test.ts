import { describe, expect, test } from "bun:test"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { AgentRegistry } from "../src/agent/registry.ts"
import { planTool } from "../src/tool/general/plan.ts"
import { bashTool } from "../src/tool/general/bash.ts"
import { readTool } from "../src/tool/fs/index.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import {
  buildPlannedExecutionMessage,
} from "../src/runtime/execution-flow.ts"
import {
  DEFAULT_EXECUTION_BUDGET_POLICY,
  delegatedTaskAttemptLimit,
  normalizeExecutionBudgetPolicy,
} from "../src/runtime/execution-budget.ts"
import {
  compileObjective,
  type StructuredObjectiveIntent,
} from "../src/runtime/objective-compiler.ts"
import {
  normalizePlanContract,
  PLAN_CONTRACT_JSON_SCHEMA,
} from "../src/runtime/plan-contract.ts"
import {
  assertPlanNodeInvocationMatches,
  compileExecutablePlan,
  compileExecutablePlanDag,
  instantiatePlannedTaskContract,
  restrictToolsToExecutablePlan,
} from "../src/runtime/executable-plan.ts"
import {
  normalizeTaskContract,
  normalizeTaskContractRevision,
} from "../src/runtime/run-contract.ts"
import { objectivePolicyFromTaskContract } from "../src/runtime/task-objective-policy.ts"
import {
  recoveryActionSatisfied,
} from "../src/runtime/agent-loop-recovery.ts"
import type {
  ExecutionRecoveryDirective,
  ToolExecutionOutcome,
} from "../src/runtime/agent-loop-control.ts"
import { executeDelegationDag } from "../src/runtime/delegation-dag.ts"
import { taskTool } from "../src/tool/general/task.ts"
import { delegateDagTool } from "../src/tool/general/delegate-dag.ts"

describe("runtime-authoritative plan contract", () => {
  test("rejects Markdown-only and otherwise hollow plans", async () => {
    const result = await planTool.execute({
      title: "看起来像计划",
      content: "1. 做事\n2. 完成",
    }, context())
    expect(result.success).toBe(false)
    expect(result.error).toContain("contract")
  })

  test("normalizes an executable DAG and derives public Markdown", async () => {
    const contract = validPlan()
    const result = await planTool.execute({ contract }, context())
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      title: "审查并验证",
      contract: {
        schemaVersion: 1,
        planId: "audit-1",
        nodes: [
          { nodeId: "inspect", assigneeAgentId: "explore" },
          { nodeId: "verify", dependsOn: ["inspect"] },
        ],
      },
    })
    expect((result.data as { content: string }).content).toContain("执行角色")
    const executable = compileExecutablePlan(
      (result.data as { contract: ReturnType<typeof normalizePlanContract> }).contract,
      process.cwd(),
    )
    const prompt = buildPlannedExecutionMessage(
      "完成审查",
      executable,
    )
    expect(prompt).toContain("[PlanContract：机器权威合同]")
    expect(prompt).toContain('"nodeId":"verify"')
    expect(prompt).toContain("Markdown 仅用于展示")
  })

  test("rejects missing dependencies, cycles, and unverifiable nodes", () => {
    const missing = validPlan()
    missing.nodes[1]!.dependsOn = ["unknown"]
    expect(() => normalizePlanContract(missing, process.cwd()))
      .toThrow("不存在的依赖")

    const cycle = validPlan()
    cycle.nodes[0]!.dependsOn = ["verify"]
    expect(() => normalizePlanContract(cycle, process.cwd()))
      .toThrow("循环依赖")

    const hollow = validPlan()
    hollow.nodes[0]!.acceptance = []
    expect(() => normalizePlanContract(hollow, process.cwd()))
      .toThrow("acceptance 不能为空")
  })

  test("model schema has no verifier field and rejects the former dual source of truth", () => {
    const schema = JSON.stringify(PLAN_CONTRACT_JSON_SCHEMA)
    expect(schema).not.toContain('"verifier"')
    const invalid = validPlan()
    invalid.nodes[0]!.acceptance[0]!.verifier = "workspace-inspection"
    expect(() => normalizePlanContract(invalid, process.cwd()))
      .toThrow("未知 [verifier]")
  })

  test("seals plan identity and compiles immutable node TaskContracts", () => {
    const executable = compileExecutablePlan(
      normalizePlanContract(validPlan(), process.cwd()),
      process.cwd(),
    )
    expect(executable.identity).toMatchObject({ planId: "audit-1", version: 1 })
    expect(executable.identity.fingerprint).toHaveLength(64)
    expect(Object.isFrozen(executable)).toBe(true)
    expect(Object.isFrozen(executable.nodes[0]?.taskContract)).toBe(true)
    expect(restrictToolsToExecutablePlan(
      ["read", "write", "bash", "task", "delegate_dag", "question"],
      executable,
    )).toEqual(["read", "write", "bash", "task", "delegate_dag", "question"])
    expect(restrictToolsToExecutablePlan(["read", "write", "task"]))
      .toEqual(["read", "write", "task"])
    const task = instantiatePlannedTaskContract({
      plan: executable,
      reference: { planId: "audit-1", version: 1, nodeId: "inspect" },
      workingDir: process.cwd(),
    })
    expect(task.planRef).toEqual({
      planId: "audit-1",
      version: 1,
      fingerprint: executable.identity.fingerprint,
      nodeId: "inspect",
    })
    expect(task.requiredEffects).toContain("workspace-read")
    expect(task.acceptanceCriteria[0]).toMatchObject({
      id: "source",
      verifier: "source-inspection",
      evidenceKinds: ["source-inspection"],
    })
  })

  test("keeps a pure external-research plan node free of process requirements", () => {
    const contract = validPlan()
    contract.nodes = [{
      nodeId: "research",
      title: "核验公开安全资料",
      instruction: "检索并总结公开安全资料。",
      goalType: "research",
      dependsOn: [],
      assigneeAgentId: "researcher",
      requiredEffects: ["network"],
      resources: { reads: [], writes: [] },
      acceptance: [{
        id: "external-research",
        label: "公开资料已核验",
        anyOf: ["external-research"],
        targetPatterns: [],
      }],
      expectedOutputs: [],
      blockingClass: "none",
    }]
    const executable = compileExecutablePlan(
      normalizePlanContract(contract, process.cwd()),
      process.cwd(),
    )
    expect(executable.nodes[0]?.taskContract.requiredEffects).toEqual(["network"])
    const task = instantiatePlannedTaskContract({
      plan: executable,
      reference: { planId: "audit-1", version: 1, nodeId: "research" },
      workingDir: process.cwd(),
    })
    expect(task.requiredEffects).toEqual(["network"])
    expect(task.acceptanceCriteria[0]).toMatchObject({
      id: "external-research",
      verifier: "research",
      evidenceKinds: ["external-research"],
    })
  })

  test("rejects stale references and contract rewrites", async () => {
    const executable = compileExecutablePlan(
      normalizePlanContract(validPlan(), process.cwd()),
      process.cwd(),
    )
    const node = executable.nodes[0]!
    expect(() => assertPlanNodeInvocationMatches({
      node,
      writes: ["packages/core/src/tampered.ts"],
    })).toThrow("权威计划节点合同不一致")
    const first = instantiatePlannedTaskContract({
      plan: executable,
      reference: { planId: "audit-1", version: 1, nodeId: "inspect" },
      workingDir: process.cwd(),
    })
    expect(() => normalizeTaskContractRevision(first, {
      ...first,
      planRef: { ...first.planRef!, version: 2 },
      instructions: "attempted rewrite",
    }, process.cwd())).toThrow("不得更换原计划身份")
    const ctx = {
      ...context(),
      runType: "root" as const,
      runId: "root-plan",
      activePlan: executable,
      modelRouter: {} as any,
    }
    const unplannedRecoveryTask = await taskTool.execute({
      subagent_name: "explore",
      description: "篡改描述",
      prompt: "篡改指令",
    }, ctx)
    expect(unplannedRecoveryTask.success).toBe(false)
    expect(unplannedRecoveryTask.error).not.toContain("必须同时引用")
    const missingDagReference = await delegateDagTool.execute({
      nodes: executable.nodes.map((item) => ({ plan_node_id: item.nodeId })),
    }, ctx)
    expect(missingDagReference.success).toBe(false)
    expect(missingDagReference.error).toContain("必须引用当前权威计划")
  })

  test("the scheduler executes the DAG compiled from plan dependencies and resources", async () => {
    const executable = compileExecutablePlan(
      normalizePlanContract(validPlan(), process.cwd()),
      process.cwd(),
    )
    const order: string[] = []
    const result = await executeDelegationDag(
      compileExecutablePlanDag(executable),
      {
        suspendParent: () => true,
        resumeParent: async () => {},
        runNode: async (node) => {
          order.push(node.id)
          return { nodeId: node.id, success: true }
        },
        cancelNode: () => "exited",
      },
    )
    expect(result.success).toBe(true)
    expect(order).toEqual(["inspect", "verify"])
    expect(compileExecutablePlanDag(executable)[1]).toMatchObject({
      id: "verify",
      dependsOn: ["inspect"],
      resources: { reads: expect.any(Array), writes: [] },
    })
  })
})

describe("objective, recovery, and total budget gates", () => {
  test("task acceptance uses the canonical verifier evidence matrix", () => {
    const contract = normalizeTaskContract({
      objective: "读取证据",
      instructions: "读取 evidence.txt 并提交证据",
      acceptance: ["已检查工作区证据"],
      acceptanceCriteria: [{
        id: "criterion-1",
        statement: "已检查工作区证据",
        verifier: "workspace-inspection",
        targetPatterns: ["evidence.txt"],
      }],
      requiredEffects: ["workspace-read"],
      resources: { reads: ["evidence.txt"], writes: [] },
    }, process.cwd())
    expect(contract.acceptanceCriteria[0]?.evidenceKinds).toEqual([
      "workspace-inspection",
      "source-inspection",
      "schematic-inspection",
      "datasheet-inspection",
    ])
    expect(objectivePolicyFromTaskContract(contract).requirements[0]?.anyOf)
      .toEqual(contract.acceptanceCriteria[0]?.evidenceKinds)
  })

  test("workspace-read always receives a runtime inspection floor", () => {
    const semantic: StructuredObjectiveIntent = {
      goalType: "research",
      requiredEffects: ["workspace-read"],
      candidateAgentIds: ["explore"],
      requiresPlanning: false,
      acceptanceRequirements: [],
    }
    const objective = compileObjective("任意原文", "full-access", {
      semanticAnalysis: semantic,
    })
    expect(objective.requiresEvidence).toBe(true)
    expect(objective.acceptancePolicy?.requirements).toEqual([{
      id: "runtime-workspace-inspection",
      label: "运行时读取并检查目标工作区内容",
      verifier: "workspace-inspection",
      anyOf: ["workspace-inspection"],
      targetPatterns: [],
    }])
  })

  test("a successful read cannot satisfy process, network, or hardware recovery", () => {
    const read = outcome("read", {
      verification: true,
      verificationTargets: ["src/main.ts"],
    })
    for (const effect of ["process", "network", "hardware"] as const) {
      expect(recoveryActionSatisfied(
        recovery(effect, ["read"]),
        read,
      )).toBe(false)
    }
    const build = outcome("compile", {
      verification: true,
      verificationTargets: ["build/app.bin"],
      category: "build",
    })
    expect(recoveryActionSatisfied(recovery("process", ["compile"]), build)).toBe(true)
    const hardware = outcome("flash", {
      verification: true,
      verificationTargets: ["usb:esp32"],
      toolEffects: ["hardware"],
    })
    expect(recoveryActionSatisfied(recovery("hardware", ["flash"]), hardware)).toBe(true)
  })

  test("normalizes absolute convergence budgets", () => {
    const budget = normalizeExecutionBudgetPolicy({
      totalDurationMs: 10 * 60_000,
      rootWindowMs: 60 * 60_000,
      maxRootWindows: 99,
      maxRevisions: 99,
      maxRecoveryStrategies: 0,
    })
    expect(budget.totalDurationMs).toBe(10 * 60_000)
    expect(budget.rootWindowMs).toBe(10 * 60_000)
    expect(budget.maxRootWindows).toBe(1)
    expect(budget.maxRevisions).toBe(50)
    expect(budget.maxRecoveryStrategies).toBe(1)
    expect(DEFAULT_EXECUTION_BUDGET_POLICY).toMatchObject({
      totalDurationMs: 2 * 60 * 60_000,
      maxRootWindows: 4,
      maxRevisions: 6,
      maxRecoveryStrategies: 8,
    })
    expect(delegatedTaskAttemptLimit({ maxRevisions: 0 })).toBe(1)
    expect(delegatedTaskAttemptLimit({ maxRevisions: 6 })).toBe(7)
    expect(delegatedTaskAttemptLimit({ maxRevisions: 500 })).toBe(51)
  })
})

function validPlan(): any {
  return {
    schemaVersion: 1,
    planId: "audit-1",
    version: 1,
    title: "审查并验证",
    nodes: [
      {
        nodeId: "inspect",
        title: "读取实现",
        instruction: "读取目标代码并提取直接证据。",
        goalType: "research",
        dependsOn: [],
        assigneeAgentId: "explore",
        requiredEffects: ["workspace-read"],
        resources: { reads: ["packages/core/src"], writes: [] },
        acceptance: [{
          id: "source",
          label: "源码已检查",
          anyOf: ["source-inspection"],
          targetPatterns: ["packages/core/src/**"],
        }],
        expectedOutputs: ["源码证据清单"],
        blockingClass: "none",
      },
      {
        nodeId: "verify",
        title: "运行验证",
        instruction: "运行定向测试并记录结果。",
        goalType: "implementation",
        dependsOn: ["inspect"],
        assigneeAgentId: "general",
        requiredEffects: ["process"],
        resources: { reads: ["packages/core"], writes: [] },
        acceptance: [{
          id: "test",
          label: "定向测试通过",
          anyOf: ["test-success"],
          targetPatterns: ["packages/core/test/**"],
        }],
        expectedOutputs: ["测试结果"],
        blockingClass: "none",
      },
    ],
  }
}

function context() {
  const agentRegistry = new AgentRegistry()
  agentRegistry.registerAll(HIDDEN_AGENTS)
  const toolRegistry = new ToolRegistry()
  toolRegistry.register(readTool)
  toolRegistry.register(bashTool)
  return {
    sessionId: "plan-test",
    agentId: "main-agent",
    workingDir: process.cwd(),
    scope: "full-access" as const,
    agentRegistry,
    toolRegistry,
  }
}

function recovery(
  effect: "process" | "network" | "hardware",
  tools: string[],
): ExecutionRecoveryDirective {
  return {
    strategyId: "strategy",
    fingerprint: "failure",
    sourceTool: "source",
    kind: "test",
    summary: "test",
    evidence: [],
    actions: ["recover"],
    actionTools: [tools],
    actionEffects: [[effect]],
    actionIndex: 0,
    attempts: 1,
    updatedAt: 1,
  }
}

function outcome(
  name: string,
  input: {
    verification: boolean
    verificationTargets: string[]
    category?: "build"
    toolEffects?: Array<"hardware" | "network">
  },
): ToolExecutionOutcome {
  return {
    name,
    result: {
      success: true,
      outcome: input.category
        ? { status: "succeeded", category: input.category, summary: "ok" }
        : undefined,
    },
    semantics: {
      mutation: false,
      verification: input.verification,
      mutationTargets: [],
      verificationTargets: input.verificationTargets,
      globalVerification: false,
    },
    toolEffects: input.toolEffects,
  } as ToolExecutionOutcome
}
