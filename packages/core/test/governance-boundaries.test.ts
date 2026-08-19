import { describe, expect, test } from "bun:test"
import type { AgentDefinition } from "../src/agent/types.ts"
import {
  deriveAcceptanceChecks,
  expectedOutputsSatisfied,
  normalizeTaskContract,
  type TaskResult,
} from "../src/runtime/run-contract.ts"
import { attestSuccessfulCommand } from "../src/runtime/command-verification-adapter.ts"
import { evaluateToolAuthorization } from "../src/runtime/tool-policy.ts"
import type { ToolDefinition } from "../src/tool/types.ts"
import { RunContractRepo } from "../src/store/run-contract.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"
import { RunGraphRepo } from "../src/store/run-graph.ts"
import { getDb } from "../src/store/database.ts"
import { TaskScheduler } from "../src/runtime/task-scheduler.ts"
import { runGraphService } from "../src/runtime/run-graph.ts"
import { WorkflowRepo } from "../src/store/workflow.ts"
import {
  requestParentApproval,
  requestParentQuestion,
} from "../src/runtime/agent-loop.ts"
import { brokerSubAgentInteraction } from "../src/runtime/main-agent-interaction-routing.ts"
import { mainAgentInteractionInbox } from "../src/runtime/main-agent-interaction-inbox.ts"
import { userQuestionManager } from "../src/runtime/user-question.ts"
import { toolApprovalManager } from "../src/runtime/tool-approval.ts"
import {
  ExecutionController,
  type ToolExecutionOutcome,
} from "../src/runtime/agent-loop-control.ts"
import {
  bindAttachmentEvidenceToRequirements,
  objectiveAcceptanceSatisfied,
} from "../src/runtime/objective-evidence-ledger.ts"
import { datasheetReadTool } from "../src/tool/schematic/datasheet-read.ts"
import { schematicReadTool } from "../src/tool/schematic/schematic-read.ts"
import { readTool, writeTool } from "../src/tool/fs/index.ts"

describe("governance boundaries", () => {
  test("trusted attachment extraction satisfies its target-bound document inspection", () => {
    const policy = {
      requirements: [{
        id: "doc-summary",
        label: "文档内容摘要",
        verifier: "workspace-inspection" as const,
        anyOf: ["workspace-inspection" as const],
        targetPatterns: ["kimik3技术报告.pdf"],
      }],
    }
    const bindings = bindAttachmentEvidenceToRequirements(policy, [{
      name: "KimiK3技术报告.pdf",
      kind: "text",
      content: "[PDF 共 47 页]\n\n这里是已经由请求边界提取的技术报告正文。",
    }])

    expect(objectiveAcceptanceSatisfied(policy, bindings)).toBe(true)
    expect(bindings).toEqual([expect.objectContaining({
      requirementId: "doc-summary",
      kind: "workspace-inspection",
      targets: ["kimik3技术报告.pdf"],
      source: "attachment:kimik3技术报告.pdf",
    })])
  })

  test("domain document tools keep explicit model-capability contracts", () => {
    expect(datasheetReadTool.contract.runtimeDependencies?.modelCapabilities)
      .toEqual(["chat", "vision"])
    expect(schematicReadTool.contract.runtimeDependencies?.modelCapabilities)
      .toEqual(["reasoning", "vision"])
  })

  test("a source read cannot satisfy a typed test criterion", () => {
    const contract = testContract("test", ["src/**"])
    const result = taskResult([{
      kind: "tool-execution",
      ref: "read-1",
      evidenceKinds: ["source-inspection"],
      targets: ["src/main.ts"],
      observedAt: contract.issuedAt + 1,
    }])
    expect(deriveAcceptanceChecks(contract, result)).toEqual([
      expect.objectContaining({ status: "failed", evidenceRefs: [] }),
    ])
  })

  test("typed evidence is bound to the criterion target and evidence epoch", () => {
    const contract = testContract("test", ["packages/core/**"])
    const wrongTarget = taskResult([{
      kind: "tool-execution",
      ref: "test-other",
      evidenceKinds: ["test-success"],
      targets: ["app"],
      observedAt: contract.issuedAt + 1,
    }])
    const stale = taskResult([{
      kind: "tool-execution",
      ref: "test-stale",
      evidenceKinds: ["test-success"],
      targets: ["packages/core"],
      observedAt: contract.issuedAt - 1,
    }])
    expect(deriveAcceptanceChecks(contract, wrongTarget)[0].status).toBe("failed")
    expect(deriveAcceptanceChecks(contract, stale)[0].status).toBe("failed")
  })

  test("runtime objective evidence from an unrelated path cannot satisfy a target-bound requirement", () => {
    const controller = targetBoundController()
    controller.observe([inspectionOutcome("src/unrelated.ts")])

    expect(controller.snapshot().runtimeObjectiveAccepted).toBe(false)
    expect(controller.snapshot().objectiveEvidenceBindings).toEqual([])
    expect(controller.onModelYield()).toBe("complete")
  })

  test("runtime objective evidence matching the normalized target survives snapshot recovery", () => {
    const controller = targetBoundController()
    controller.observe([inspectionOutcome(".\\SRC\\main.ts")])

    const snapshot = controller.snapshot()
    expect(snapshot.runtimeObjectiveAccepted).toBe(true)
    expect(snapshot.objectiveEvidenceBindings).toEqual([
      expect.objectContaining({
        requirementId: "source",
        kind: "source-inspection",
        targets: ["src/main.ts"],
        globalVerification: false,
      }),
    ])

    const restored = new ExecutionController(4, 8, 60_000, 3, { initial: snapshot })
    expect(restored.snapshot().runtimeObjectiveAccepted).toBe(true)
    expect(restored.onModelYield()).toBe("complete")
  })

  test("a runtime-declared global verifier can cover a target-bound requirement", () => {
    const controller = targetBoundController()
    controller.observe([inspectionOutcome("src/workspace-audit.ts", true)])

    expect(controller.snapshot().runtimeObjectiveAccepted).toBe(true)
    expect(controller.snapshot().objectiveEvidenceBindings).toEqual([
      expect.objectContaining({
        requirementId: "source",
        kind: "source-inspection",
        globalVerification: true,
      }),
    ])
    expect(controller.onModelYield()).toBe("complete")
  })

  test("generic shell labels cannot forge test evidence", () => {
    expect(attestSuccessfulCommand({
      command: "echo test",
      cwdTarget: "packages/core",
      requested: "test",
    }).map((item) => item.kind)).toEqual(["process-verification"])
    expect(attestSuccessfulCommand({
      command: "bun test packages/core/test/governance-boundaries.test.ts",
      cwdTarget: ".",
      requested: "test",
    }).map((item) => item.kind)).toEqual(["process-verification", "test-success"])
    expect(attestSuccessfulCommand({
      command: "bun test foo && echo test",
      cwdTarget: ".",
      requested: "test",
    }).map((item) => item.kind)).toEqual(["process-verification"])
  })

  test("expected outputs require every exact file or glob", () => {
    expect(expectedOutputsSatisfied(
      ["dist/app.hex", "reports/*.json"],
      [{
        kind: "file",
        ref: "dist/app.hex",
        targets: ["dist/app.hex"],
      }],
    )).toBe(false)
    expect(expectedOutputsSatisfied(
      ["dist/app.hex", "reports/*.json"],
      [
        { kind: "file", ref: "dist/app.hex", targets: ["dist/app.hex"] },
        { kind: "file", ref: "reports/test.json", targets: ["reports/test.json"] },
      ],
    )).toBe(true)
  })

  test("permission selection is most-specific and otherwise default-deny", () => {
    const definition: AgentDefinition = {
      id: "worker",
      name: "worker",
      description: "",
      mode: "hidden",
      requiredCapabilities: ["chat"],
      tools: ["write"],
      permissions: [
        { permission: "*", pattern: "**", effect: "deny" },
        { permission: "write", pattern: "src/**", effect: "allow" },
      ],
      systemPrompt: "",
      maxSteps: 1,
    }
    const write = tool("write", "write", ["workspace-write"])
    expect(evaluateToolAuthorization(
      definition, write, new Set(["write"]), "auto-edit", { path: "src/main.ts" },
    ).action).toBe("allow")
    expect(evaluateToolAuthorization(
      definition, write, new Set(["write"]), "auto-edit", { path: "docs/readme.md" },
    ).action).toBe("deny")
    expect(evaluateToolAuthorization(
      { ...definition, permissions: [] },
      write,
      new Set(["write"]),
      "auto-edit",
      { path: "src/main.ts" },
    ).action).toBe("deny")
  })

  test("TaskContract resource claims are an enforced child capability", () => {
    const definition: AgentDefinition = {
      id: "worker",
      name: "worker",
      description: "",
      mode: "hidden",
      requiredCapabilities: ["chat"],
      tools: ["write"],
      permissions: [{ permission: "write", pattern: "**", effect: "allow" }],
      systemPrompt: "",
      maxSteps: 1,
    }
    const write = tool("write", "write", ["workspace-write"])
    const capability = {
      workingDir: process.cwd(),
      resources: { reads: ["src/**"], writes: ["src/**"] },
    }
    expect(evaluateToolAuthorization(
      definition, write, new Set(["write"]), "auto-edit", { path: "src/main.ts" }, undefined, capability,
    ).action).toBe("allow")
    expect(evaluateToolAuthorization(
      definition, write, new Set(["write"]), "auto-edit", { path: "../outside.txt" }, undefined, capability,
    ).action).toBe("deny")
  })

  test("a headless child interaction fails closed without entering public managers", async () => {
    const sessionId = `headless-${Date.now()}-${Math.random()}`
    const questionCount = userQuestionManager.list(sessionId).length
    const approvalCount = toolApprovalManager.list(sessionId).length
    expect(await requestParentQuestion(undefined, {
      id: "child-question",
      sessionId,
      runId: "child-run",
      toolCallId: "call-question",
      question: "choose",
      options: ["A"],
      allowCustom: false,
      createdAt: Date.now(),
    })).toEqual({ status: "cancelled" })
    expect(await requestParentApproval(undefined, {
      id: "child-approval",
      sessionId,
      runId: "child-run",
      parentRunId: "root-run",
      toolCallId: "call-approval",
      toolName: "write",
      input: { path: "src/main.ts" },
      reason: "write",
      target: "src/main.ts",
      createdAt: Date.now(),
      expiresAt: Date.now() + 1_000,
    })).toBe("cancelled")
    expect(userQuestionManager.list(sessionId)).toHaveLength(questionCount)
    expect(toolApprovalManager.list(sessionId)).toHaveLength(approvalCount)
  })

  test("the root broker maps child questions and approvals to the root and returns resolutions", async () => {
    const suffix = `${Date.now()}-${Math.random()}`
    const sessionId = `interaction-${suffix}`
    const rootRunId = `root-${suffix}`
    const childRunId = `child-${suffix}`
    SessionRepo.create({
      id: sessionId,
      title: "interaction",
      agent_id: "main-agent",
      project_path: process.cwd(),
    })
    TaskRunRepo.create(taskView(rootRunId, sessionId, "running"))
    TaskRunRepo.create({
      ...taskView(childRunId, sessionId, "running"),
      parentRunId: rootRunId,
    })
    const published: Array<{ type: string; payload: any }> = []
    try {
      const questionPromise = brokerSubAgentInteraction({
        rootRunId,
        sessionId,
        request: {
          type: "question-request",
          payload: {
            question: {
              id: "source-question",
              runId: childRunId,
              toolCallId: "child-call",
              question: "请选择目标芯片",
              options: ["A", "B"],
              allowCustom: false,
              createdAt: Date.now(),
            },
          },
          requiresMainAgentReview: true,
          visibility: "internal",
        },
        publish: (type, payload) => published.push({ type, payload }),
      })
      await Promise.resolve()
      const publicQuestion = published.find((item) => item.type === "question-request")?.payload
      expect(publicQuestion.runId).toBe(rootRunId)
      expect(JSON.stringify(publicQuestion)).not.toContain(childRunId)
      expect(userQuestionManager.respond(publicQuestion.id, "A")).not.toBeNull()
      expect(await questionPromise).toEqual({ status: "answered", answer: "A" })

      const approvalPromise = brokerSubAgentInteraction({
        rootRunId,
        sessionId,
        request: {
          type: "approval-request",
          payload: {
            approval: {
              id: "source-approval",
              runId: childRunId,
              toolCallId: "child-write",
              toolName: "write",
              input: { path: "src/main.ts" },
              reason: "需要更新当前任务产物",
            },
          },
          requiresMainAgentReview: true,
          visibility: "internal",
        },
        publish: (type, payload) => published.push({ type, payload }),
      })
      await Promise.resolve()
      const publicApproval = published.find((item) => item.type === "approval-request")?.payload
      expect(publicApproval.runId).toBe(rootRunId)
      expect(JSON.stringify(publicApproval)).not.toContain(childRunId)
      expect(toolApprovalManager.respond(publicApproval.id, "allow-once")).not.toBeNull()
      expect(await approvalPromise).toEqual({ status: "approved" })
      expect(mainAgentInteractionInbox.list(rootRunId).map((item) => item.state))
        .toEqual(["resolved", "resolved"])
    } finally {
      for (const pending of userQuestionManager.list(sessionId)) userQuestionManager.cancel(pending.id)
      for (const pending of toolApprovalManager.list(sessionId)) toolApprovalManager.respond(pending.id, "deny")
      getDb().run("DELETE FROM main_agent_interactions WHERE root_run_id = ?", [rootRunId])
      TaskRunRepo.deleteBySession(sessionId)
      SessionRepo.delete(sessionId)
    }
  })

  test("TaskResult and direct completion roll back as one transaction", () => {
    const suffix = `${Date.now()}-${Math.random()}`
    const sessionId = `governance-${suffix}`
    const triggerName = `fail_review_${String(Date.now()).replace(/\D/g, "")}`
    SessionRepo.create({
      id: sessionId,
      title: "governance",
      agent_id: "main-agent",
      project_path: process.cwd(),
    })
    const scheduler = new TaskScheduler(1, 10, TaskRunRepo, runGraphService)
    const task = scheduler.enqueue({
      sessionId,
      agentId: "worker",
      priority: 8,
      type: "background",
      message: "atomic review",
      workingDir: process.cwd(),
      resourceClaims: { reads: ["src/**"], writes: [] },
    })
    const workflow = WorkflowRepo.create({
      sessionId,
      templateId: "governance-test",
      goal: "atomic workflow review",
      workingDir: process.cwd(),
      nodes: [{ title: "verify", agentId: "worker", prompt: "verify" }],
    })
    const workflowNode = workflow.nodes[0]
    WorkflowRepo.updateNode(workflowNode.id, {
      status: "running",
      taskRunId: task.id,
      startedAt: Date.now(),
    })
    const contract = testContract("process", [])
    RunContractRepo.create({
      runId: task.id,
      sessionId,
      agentId: "worker",
      contract,
    })
    runGraphService.bindContract(task.id, contract)
    const result = taskResult([{
      kind: "tool-execution",
      ref: "process-1",
      evidenceKinds: ["process-verification"],
      targets: ["src"],
      observedAt: contract.issuedAt + 1,
    }])
    try {
      getDb().run(
        `CREATE TRIGGER ${triggerName} BEFORE UPDATE OF status ON run_graph_nodes
         WHEN NEW.id = '${task.id}' BEGIN SELECT RAISE(ABORT, 'injected graph failure'); END`,
      )
      expect(() => RunContractRepo.commitCompletedResult(task.id, result, "done")).toThrow()
      expect(RunContractRepo.get(task.id)?.result).toBeUndefined()
      expect(TaskRunRepo.get(task.id)?.status).toBe("running")
      expect(RunGraphRepo.getNode(task.id)?.status).toBe("running")

      getDb().run(`DROP TRIGGER ${triggerName}`)
      getDb().run(
        `CREATE TRIGGER ${triggerName} BEFORE UPDATE OF status ON workflow_nodes
         WHEN NEW.id = '${workflowNode.id}' BEGIN SELECT RAISE(ABORT, 'injected workflow failure'); END`,
      )
      expect(() => RunContractRepo.commitCompletedResult(
        task.id,
        result,
        "done",
        { workflowNodeId: workflowNode.id },
      )).toThrow()
      expect(RunContractRepo.get(task.id)?.result).toBeUndefined()
      expect(TaskRunRepo.get(task.id)?.status).toBe("running")
      expect(RunGraphRepo.getNode(task.id)?.status).toBe("running")
      expect(WorkflowRepo.getNode(workflowNode.id)?.status).toBe("running")

      getDb().run(`DROP TRIGGER ${triggerName}`)
      expect(RunContractRepo.commitCompletedResult(
        task.id,
        result,
        "done",
        { workflowNodeId: workflowNode.id },
      )).toBe(true)
      expect(RunContractRepo.get(task.id)?.result?.summary).toBe("done")
      expect(TaskRunRepo.get(task.id)?.status).toBe("completed")
      expect(RunGraphRepo.getNode(task.id)?.status).toBe("accepted")
      expect(WorkflowRepo.getNode(workflowNode.id)?.status).toBe("completed")
      WorkflowRepo.recoverInterrupted()
      expect(WorkflowRepo.getNode(workflowNode.id)?.status).toBe("completed")
      expect(scheduler.adoptCompletedSettlement(task.id, "done")).toBe(true)
      expect(scheduler.getTask(task.id)?.status).toBe("completed")
    } finally {
      try { getDb().run(`DROP TRIGGER IF EXISTS ${triggerName}`) } catch {}
      RunContractRepo.deleteBySession(sessionId)
      TaskRunRepo.deleteBySession(sessionId)
      RunGraphRepo.delete(task.id)
      WorkflowRepo.delete(workflow.id)
      SessionRepo.delete(sessionId)
    }
  })
})

function testContract(
  verifier: "test" | "process",
  targetPatterns: string[],
) {
  return normalizeTaskContract({
    objective: "verify",
    instructions: "verify",
    acceptance: ["verified"],
    acceptanceCriteria: [{
      id: "criterion-1",
      statement: "verified",
      verifier,
      evidenceKinds: verifier === "test" ? ["test-success"] : ["process-verification"],
      targetPatterns,
      issuedAt: 0,
    }],
  }, process.cwd())
}

function taskResult(evidence: TaskResult["evidence"]): TaskResult {
  return {
    status: "completed",
    summary: "done",
    output: "done",
    artifacts: [],
    evidence,
    unresolved: [],
    completedAt: Date.now(),
  }
}

function targetBoundController(): ExecutionController {
  return new ExecutionController(4, 8, 60_000, 3, {
    objective: {
      content: "inspect target source",
      acceptance: "target source inspected",
      acceptancePolicy: {
        requirements: [{
          id: "source",
          label: "inspect src/main.ts",
          verifier: "source-inspection",
          anyOf: ["source-inspection"],
          targetPatterns: ["src/main.ts"],
        }],
      },
    },
  })
}

function inspectionOutcome(
  target: string,
  globalVerification = false,
): ToolExecutionOutcome {
  return {
    name: "read",
    input: { paths: [target] },
    executionId: `read:${target}`,
    result: {
      success: true,
      outcome: {
        status: "succeeded",
        category: "evidence",
        summary: `read ${target}`,
      },
    },
    semantics: {
      mutation: false,
      verification: true,
      mutationTargets: [],
      verificationTargets: [target],
      globalVerification,
    },
  }
}

function tool(
  name: string,
  permission: string,
  effects: ToolDefinition["contract"]["effects"],
): ToolDefinition {
  return {
    name,
    permission,
    description: "",
    parameters: { type: "object" },
    contract: {
      effects,
      idempotency: "unknown",
      cancellation: "unsupported",
      progress: { role: "dynamic", targetParameters: ["path"] },
    },
    execute: async () => ({ success: true }),
  }
}

function taskView(
  id: string,
  sessionId: string,
  status: "running" | "safety-quarantine" | "interrupted",
) {
  return {
    id,
    sessionId,
    agentId: "worker",
    priority: 8,
    status,
    message: id,
    workingDir: process.cwd(),
    type: "background" as const,
    createdAt: Date.now(),
    startedAt: status === "running" ? Date.now() : undefined,
  }
}
