import {
  bindObjectiveEvidenceToRequirements,
} from "../src/runtime/objective-evidence-ledger.ts"
import type { ToolExecutionOutcome } from "../src/runtime/agent-loop-control.ts"
import type { ObjectiveAcceptancePolicy } from "../src/runtime/objective-compiler.ts"
import {
  evidenceReferencesFromExecutions,
} from "../src/runtime/run-contract.ts"
import { TaskScheduler } from "../src/runtime/task-scheduler.ts"
import {
  toolInvocationResourceClaims,
} from "../src/runtime/tool-policy.ts"
import type { ToolExecutionView } from "../src/store/tool-execution.ts"
import { writeTool } from "../src/tool/fs/index.ts"
import { bashTool } from "../src/tool/general/bash.ts"

const HARDWARE_POLICY: ObjectiveAcceptancePolicy = {
  requirements: [{
    id: "hardware",
    label: "取得真实硬件观测",
    verifier: "hardware",
    anyOf: ["hardware-observation"],
    targetPatterns: [],
  }],
}

describe("multi-Agent runtime boundaries", () => {
  test("hardware control actions never satisfy hardware observation", () => {
    for (const outcome of [
      hardwareOutcome("swd_debug", "reset"),
      hardwareOutcome("serial_open", "send"),
      hardwareOutcome("serial_open", "close"),
      hardwareOutcome("flash", "", { verified: false }),
    ]) {
      expect(bindObjectiveEvidenceToRequirements(HARDWARE_POLICY, outcome))
        .toEqual([])
    }
  })

  test("only returned observations and verified flash satisfy hardware observation", () => {
    for (const outcome of [
      hardwareOutcome("usb_detect", "list"),
      hardwareOutcome("serial_open", "receive"),
      hardwareOutcome("flash", "", {
        verified: true,
        verificationEvidence: "esptool verify succeeded",
      }),
    ]) {
      expect(bindObjectiveEvidenceToRequirements(HARDWARE_POLICY, outcome))
        .toEqual([expect.objectContaining({
          requirementId: "hardware",
          kind: "hardware-observation",
        })])
    }
  })

  test("durable execution evidence applies the same action boundary", () => {
    for (const execution of [
      durableExecution("swd_debug", "reset"),
      durableExecution("serial_open", "send"),
      durableExecution("serial_open", "close"),
    ]) {
      expect(evidenceKinds(execution)).not.toContain("hardware-observation")
    }
    for (const execution of [
      durableExecution("usb_detect", "list"),
      durableExecution("serial_open", "receive"),
    ]) {
      expect(evidenceKinds(execution)).toContain("hardware-observation")
    }
  })

  test("root tool invocations conflict with active child and review-barrier leases", () => {
    const scheduler = new TaskScheduler(4)
    const root = scheduler.enqueue({
      sessionId: "root-session",
      agentId: "main-agent",
      priority: 8,
      type: "chat",
      message: "root",
      workingDir: process.cwd(),
      laneKey: "root:session",
    })
    const child = scheduler.enqueue({
      parentRunId: root.id,
      sessionId: "root-session",
      agentId: "firmware-engineer",
      priority: 7,
      type: "background",
      message: "edit source",
      workingDir: process.cwd(),
      laneKey: `child:${root.id}`,
      laneOwner: root.id,
      resourceClaims: { reads: [], writes: ["src"] },
    })
    expect(root.status).toBe("running")
    expect(child.status).toBe("running")

    const writeClaims = toolInvocationResourceClaims(
      writeTool,
      { path: "src/main.ts", content: "updated" },
      process.cwd(),
    )
    expect(scheduler.findResourceConflicts(root.id, writeClaims).map((item) => item.id))
      .toEqual([child.id])

    expect(scheduler.quarantineForSafety(child.id, "workspace cleanup unresolved")).toBe(true)
    expect(child.status).toBe("safety-quarantine")
    expect(scheduler.findResourceConflicts(root.id, writeClaims).map((item) => item.id))
      .toEqual([child.id])

    expect(scheduler.cancel(child.id)).toBe(true)
    expect(scheduler.findResourceConflicts(root.id, writeClaims)).toEqual([])
  })

  test("disjoint resources run in parallel while root shell remains globally fenced", () => {
    const scheduler = new TaskScheduler(4)
    const root = scheduler.enqueue({
      sessionId: "parallel-session",
      agentId: "main-agent",
      priority: 8,
      type: "chat",
      message: "root",
      workingDir: process.cwd(),
      laneKey: "root:parallel",
    })
    const sourceWorker = scheduler.enqueue({
      parentRunId: root.id,
      sessionId: "parallel-session",
      agentId: "firmware-engineer",
      priority: 7,
      type: "background",
      message: "source",
      workingDir: process.cwd(),
      laneKey: "worker:source",
      laneOwner: root.id,
      resourceClaims: { reads: [], writes: ["src"] },
    })
    const docsWorker = scheduler.enqueue({
      parentRunId: root.id,
      sessionId: "parallel-session",
      agentId: "doc-writer",
      priority: 7,
      type: "background",
      message: "docs",
      workingDir: process.cwd(),
      laneKey: "worker:docs",
      laneOwner: root.id,
      resourceClaims: { reads: [], writes: ["docs"] },
    })

    expect(sourceWorker.status).toBe("running")
    expect(docsWorker.status).toBe("running")
    const independentClaims = toolInvocationResourceClaims(
      writeTool,
      { path: "tests/runtime.test.ts", content: "test" },
      process.cwd(),
    )
    expect(scheduler.findResourceConflicts(root.id, independentClaims)).toEqual([])

    const shellClaims = toolInvocationResourceClaims(
      bashTool,
      { command: "pnpm test" },
      process.cwd(),
    )
    expect(scheduler.findResourceConflicts(root.id, shellClaims).map((item) => item.id).sort())
      .toEqual([docsWorker.id, sourceWorker.id].sort())
  })
})

function hardwareOutcome(
  name: string,
  action: string,
  data: Record<string, unknown> = {},
): ToolExecutionOutcome {
  return {
    name,
    input: action ? { action } : {},
    toolEffects: ["hardware"],
    result: {
      success: true,
      data,
      outcome: {
        status: "succeeded",
        category: "generic",
        summary: "ok",
      },
    },
    semantics: {
      mutation: false,
      verification: true,
      mutationTargets: [],
      verificationTargets: ["device"],
      globalVerification: false,
    },
  }
}

function durableExecution(toolName: string, action: string): ToolExecutionView {
  return {
    id: `${toolName}-${action}`,
    sessionId: "durable-hardware",
    runId: "root",
    toolCallId: `${toolName}-${action}-call`,
    toolName,
    input: { action },
    status: "succeeded",
    linesAdded: 0,
    linesRemoved: 0,
    reversible: false,
    startedAt: Date.now(),
    finishedAt: Date.now() + 1,
  }
}

function evidenceKinds(execution: ToolExecutionView): string[] {
  return evidenceReferencesFromExecutions([execution])
    .flatMap((reference) => reference.evidenceKinds ?? [])
}
