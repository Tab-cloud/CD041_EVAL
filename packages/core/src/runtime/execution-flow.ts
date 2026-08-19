import type { ExecutionScope } from "./tool-policy.ts"
import type {
  ObjectiveAcceptancePolicy,
  ObjectiveIntent,
} from "./objective-compiler.ts"
import {
  renderPlanContractMarkdown,
  serializePlanContractForExecution,
} from "./plan-contract.ts"
import type { ExecutablePlan } from "./executable-plan.ts"

export type ExecutionPhase = "planning" | "execution"

export interface ExecutionFlow {
  phase: ExecutionPhase
  scope: ExecutionScope
  executionScope: ExecutionScope
  continueAfterPlan: boolean
}

export interface ExecutionPhaseContract {
  acceptancePolicy?: ObjectiveAcceptancePolicy
  /**
   * Runtime control-plane tools made available only for this phase.
   *
   * These names are deliberately separate from the objective's domain effect
   * envelope. Planning must not broaden a research objective from `network`
   * into every `user-interaction` capability merely because the runtime needs
   * the `plan` protocol.
   */
  controlToolNames: string[]
  /** Tools whose visibility must be proven before the model is called. */
  requiredToolNames: string[]
}

/**
 * Compile the acceptance boundary for the active workflow phase.
 *
 * Automatic planning is operational control work: prose is not a plan
 * submission. Only a successful native plan tool call may advance the same
 * root run into its execution phase.
 */
export function resolveExecutionPhaseContract(input: {
  scope: ExecutionScope
  automaticPlanningPending: boolean
  objective: ObjectiveIntent
}): ExecutionPhaseContract {
  if (input.automaticPlanningPending) {
    return {
      controlToolNames: ["plan", "question", "todowrite"],
      requiredToolNames: ["plan"],
      acceptancePolicy: {
        requirements: [{
          id: "plan",
          label: "通过 plan 工具提交结构化执行计划",
          verifier: "plan",
          anyOf: ["plan-submission"],
          targetPatterns: [],
        }],
      },
    }
  }
  if (input.scope === "plan-mode") {
    return {
      controlToolNames: ["plan", "question", "todowrite"],
      requiredToolNames: [],
    }
  }
  return {
    controlToolNames: ["question", "todowrite"],
    requiredToolNames: [],
  }
}

/** Planning is a transient workflow phase, not an execution permission level. */
export function resolveExecutionFlow(
  requestedScope: ExecutionScope,
  automaticPlanning: boolean,
): ExecutionFlow {
  if (automaticPlanning) {
    return {
      phase: "planning",
      scope: "plan-mode",
      executionScope: requestedScope,
      continueAfterPlan: true,
    }
  }
  return {
    phase: requestedScope === "plan-mode" ? "planning" : "execution",
    scope: requestedScope,
    executionScope: requestedScope,
    continueAfterPlan: false,
  }
}

export function buildPlannedExecutionMessage(
  originalMessage: string,
  plan: ExecutablePlan,
): string {
  const contract = plan.contract
  const content = renderPlanContractMarkdown(contract)
  return [
    originalMessage,
    "",
    "[运行时阶段转换] 自动规划已经完成，现在进入执行阶段。",
    `计划标题：${contract.title}`,
    `计划展示：\n${content}`,
    "[PlanContract：机器权威合同]",
    serializePlanContractForExecution(contract),
    "[/PlanContract]",
    `权威计划引用：${plan.identity.planId}@${plan.identity.version}`,
    "后续 task/delegate_dag 只能通过 planId/version/nodeId 引用此计划；依赖、角色、资源和验收由运行时注入，Markdown 仅用于展示。",
    "请立即按计划执行并验证结果，不要再次提交 plan。",
  ].join("\n")
}
