import {
  normalizeObjectiveEvidenceRequirements,
  type ObjectiveAcceptancePolicy,
} from "./objective-compiler.ts"
import type { TaskContract } from "./run-contract.ts"

export class TaskObjectivePolicyRequiredError extends Error {
  readonly code = "task-objective-policy-required"

  constructor(runLabel = "子任务") {
    super(`${runLabel}缺少结构化验收条件，不能启动需要证据门控的 AgentLoop`)
    this.name = "TaskObjectivePolicyRequiredError"
  }
}

/**
 * Project a parent-issued TaskContract into the child AgentLoop evidence gate.
 *
 * No task prose is interpreted here. The parent contract already owns typed
 * verifier, evidence kind and target bindings, so the child receives exactly
 * that immutable acceptance boundary.
 */
export function objectivePolicyFromTaskContract(
  contract: TaskContract,
): ObjectiveAcceptancePolicy {
  if (!contract.acceptanceCriteria.length) {
    throw new TaskObjectivePolicyRequiredError(contract.logicalTaskId ?? "子任务")
  }
  return {
    requirements: normalizeObjectiveEvidenceRequirements(
      contract.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        label: criterion.statement,
        verifier: criterion.verifier,
        anyOf: criterion.evidenceKinds,
        targetPatterns: criterion.targetPatterns,
      })),
    ),
  }
}
