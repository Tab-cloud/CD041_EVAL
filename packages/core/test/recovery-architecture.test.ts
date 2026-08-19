import { describe, expect, test } from "bun:test"
import {
  ExecutionController,
  type ToolExecutionOutcome,
} from "../src/runtime/agent-loop-control.ts"
import { todoMayBlockObjective } from "../src/runtime/blocker-arbiter.ts"
import { DEFAULT_EXECUTION_BUDGET_POLICY } from "../src/runtime/execution-budget.ts"
import { invalidToolInputResult } from "../src/tool/outcome.ts"
import { readTool } from "../src/tool/fs/index.ts"

describe("runtime-owned recovery architecture", () => {
  test("generic failures create alternative strategies without parsing nextActions prose", () => {
    const controller = new ExecutionController(4, 20, 60_000, 3, {
      objective: { content: "完成任务", acceptance: "取得工具证据" },
    })
    const first = failure("read", "read:missing", ["不要把这句话解析成工具选择"])

    controller.observe([first])
    expect(controller.currentRecovery()).toMatchObject({
      strategyId: "read:missing:runtime-inspect-adjust-retry",
      actionIndex: 0,
    })
    expect(controller.snapshot().recoveryLedger?.strategies).toHaveLength(2)
    expect(controller.currentRecovery()?.actions.join("\n"))
      .not.toContain("不要把这句话解析成工具选择")

    controller.observe([first])
    expect(controller.currentRecovery()).toMatchObject({
      strategyId: "read:missing:runtime-alternative-capability",
    })
    expect(controller.snapshot().recoveryLedger?.strategies.map((strategy) => strategy.status))
      .toEqual(["failed", "active"])
  })

  test("non-blocking domain failures stay in the normal loop instead of forcing recovery", async () => {
    const result = await readTool.execute({
      paths: ["EvalArchitectureTests/target-not-created-yet.md"],
    }, {
      workingDir: "D:\\eval",
      sessionId: "read-missing-control",
      agentId: "doc-writer",
    } as any)
    expect(result).toMatchObject({
      success: false,
      outcome: {
        diagnostic: {
          kind: "path-not-found",
          failureDisposition: "continue",
        },
      },
    })

    const controller = new ExecutionController(4, 20, 60_000, 3, {
      objective: { content: "创建文档", acceptance: "文档已经写入" },
    })
    const decision = controller.observe([{
      name: "read",
      input: { paths: ["EvalArchitectureTests/target-not-created-yet.md"] },
      result,
      semantics: {
        mutation: false,
        verification: true,
        mutationTargets: [],
        verificationTargets: ["EvalArchitectureTests/target-not-created-yet.md"],
        globalVerification: false,
      },
    }])

    expect(decision.phase).toBe("execution")
    expect(decision.stopReason).toBeUndefined()
    expect(controller.currentRecovery()).toBeUndefined()
    expect(controller.hasFailedInvocation("read", {
      paths: ["EvalArchitectureTests/target-not-created-yet.md"],
    })).toBe(true)
  })

  test("recovery strategies obey the objective-wide runtime budget", () => {
    const controller = new ExecutionController(4, 20, 60_000, 3, {
      objective: { content: "完成任务", acceptance: "取得工具证据" },
      budgetPolicy: {
        ...DEFAULT_EXECUTION_BUDGET_POLICY,
        maxRecoveryStrategies: 1,
      },
    })
    const failed = failure("read", "read:budgeted", [])

    controller.observe([failed])
    expect(controller.snapshot().recoveryLedger?.strategies).toHaveLength(1)
    expect(controller.currentRecovery()?.strategyId)
      .toBe("read:budgeted:runtime-inspect-adjust-retry")

    controller.observe([failed])
    expect(controller.snapshot().recoveryLedger?.strategies).toHaveLength(1)
    expect(controller.currentRecovery()).toBeUndefined()
  })

  test("changing schema error details cannot mint another recovery strategy", () => {
    const controller = new ExecutionController(4, 20, 60_000, 3, {
      objective: { content: "鎻愪氦璁″垝", acceptance: "璁″垝鍚堝悓鏈夋晥" },
    })
    const failedInput = (detail: string): ToolExecutionOutcome => ({
      name: "plan",
      input: { contract: detail },
      result: invalidToolInputResult("plan", new Error(detail)),
      semantics: {
        mutation: false,
        verification: false,
        mutationTargets: [],
        verificationTargets: [],
        globalVerification: false,
      },
    })

    controller.observe([failedInput("missing expectedOutputs")])
    expect(controller.currentRecovery()?.strategyId)
      .toBe("tool-input-invalid:plan:repair-native-tool-input")
    expect(controller.currentRecovery()?.actionTools).toEqual([["plan"]])
    expect(controller.currentRecovery()?.actionEffects).toEqual([[]])

    const exhausted = controller.observe([failedInput("contract must be object")])
    expect(controller.snapshot().recoveryLedger?.strategies).toHaveLength(1)
    expect(controller.currentRecovery()).toBeUndefined()
    expect(exhausted).toMatchObject({
      phase: "execution",
    })
    expect(controller.currentRound().toolsEnabled).toBe(true)
  })

  test("hidden duration counters do not terminate an objective and root windows remain renewable", () => {
    const now = Date.now()
    const durationExpired = new ExecutionController(4, 20, 60_000, 3, {
      objective: { content: "完成任务", acceptance: "取得工具证据" },
      budgetPolicy: DEFAULT_EXECUTION_BUDGET_POLICY,
      initial: {
        rootStartedAt: now - DEFAULT_EXECUTION_BUDGET_POLICY.totalDurationMs - 1,
        rootWindowsUsed: 1,
      },
    })
    expect(durationExpired.checkTime().stopReason).toBeUndefined()

    const windowExhausted = new ExecutionController(4, 20, 1, 3, {
      objective: { content: "完成任务", acceptance: "取得工具证据" },
      budgetPolicy: {
        ...DEFAULT_EXECUTION_BUDGET_POLICY,
        maxRootWindows: 1,
      },
    })
    const started = Date.now()
    while (Date.now() - started <= 1) {}
    expect(windowExhausted.checkTime().stopReason).toBe("time-limit")
    expect(windowExhausted.canRenewTimeWindow()).toBe(true)
  })

  test("an identical failed invocation is rejected until new evidence advances progress", () => {
    const controller = new ExecutionController(4, 20, 60_000, 3, {
      objective: { content: "完成任务", acceptance: "取得工具证据" },
    })
    const input = { paths: ["missing"] }
    controller.observe([failure("read", "read:missing", [])])
    expect(controller.hasFailedInvocation("read", input)).toBe(true)

    controller.observe([{
      name: "glob",
      input: { patterns: ["**/*"] },
      result: {
        success: true,
        outcome: { status: "succeeded", category: "evidence", summary: "发现候选文件" },
      },
      semantics: {
        mutation: false,
        verification: true,
        mutationTargets: [],
        verificationTargets: ["**/*"],
        globalVerification: false,
      },
    }])
    expect(controller.hasFailedInvocation("read", input)).toBe(false)
  })

  test("only externally observable acceptance evidence may block the root objective", () => {
    expect(todoMayBlockObjective(
      "source-inspection",
      new Set(["source-inspection"]),
    )).toBe(false)
    expect(todoMayBlockObjective(
      "hardware-observation",
      new Set(["hardware-observation"]),
    )).toBe(true)
  })

  test("model-authored internal blockers are moved outside the acceptance graph", () => {
    const controller = new ExecutionController(4, 20, 60_000, 3, {
      initialTodos: [{
        content: "读取源码",
        status: "blocked",
        priority: "high",
        blockedBy: "source-inspection",
        acceptance: "读取 src",
      }],
      objective: {
        content: "审查源码",
        acceptance: "源码读取证据",
        acceptancePolicy: {
          requirements: [{
            id: "source",
            label: "源码读取",
            anyOf: ["source-inspection"],
          }],
        },
      },
    })

    expect(controller.snapshot().todos.some((todo) =>
      todo.status === "blocked" && todo.blockedBy === "source-inspection")).toBe(false)
    expect(controller.snapshot().followups?.map((followup) => followup.content))
      .toContain("读取源码")
    expect(controller.hasRunnableTodos()).toBe(true)
  })
})

function failure(
  name: string,
  fingerprint: string,
  nextActions: string[],
): ToolExecutionOutcome {
  return {
    name,
    input: { paths: ["missing"] },
    result: {
      success: false,
      error: "missing",
      outcome: {
        status: "failed",
        category: "generic",
        summary: "missing",
        fingerprint,
        diagnostic: {
          kind: "missing",
          evidence: ["missing"],
          nextActions,
        },
      },
    },
    semantics: {
      mutation: false,
      verification: true,
      mutationTargets: [],
      verificationTargets: ["missing"],
      globalVerification: false,
    },
  }
}
