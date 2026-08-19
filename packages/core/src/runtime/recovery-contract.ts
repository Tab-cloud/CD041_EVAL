import type {
  ExecutionRecoveryDirective,
  ToolExecutionOutcome,
} from "./agent-loop-control.ts"

/** Convert machine diagnostics into one bounded instruction for the next turn. */
export function buildEvidenceRecoveryInstruction(outcomes: ToolExecutionOutcome[]): string {
  const recoveries = outcomes
    .filter((outcome) => !outcome.result.success)
    .flatMap((outcome) => outcome.result.outcome?.diagnostic?.nextActions ?? [])
  const actions = [...new Set(recoveries.map((action) => action.trim()).filter(Boolean))]
  if (actions.length === 0) return ""
  return [
    "检测到工具提供了恢复建议。这不是任务终止条件，也不要向用户报告为最终失败。",
    "这些是诊断建议，不是运行时强制的有序工具协议；请依据当前证据选择必要动作，然后继续原目标和后续验证：",
    ...actions.map((action, index) => `${index + 1}. ${action}`),
    "不得绕过安全或证据门禁，不得原样重复刚才的失败调用。",
  ].join("\n")
}

/** Project durable recovery state into the current model turn. */
export function buildActiveRecoveryInstruction(
  recovery: ExecutionRecoveryDirective | undefined,
): string {
  if (!recovery) return ""
  const index = Math.min(recovery.actionIndex, recovery.actions.length - 1)
  return [
    `运行时恢复契约仍在执行：${recovery.summary}`,
    `当前候选策略：${recovery.strategyId}（第 ${recovery.attempts} 次受控尝试）`,
    `当前恢复动作（${index + 1}/${recovery.actions.length}）：${recovery.actions[index]}`,
    `后续动作：${recovery.actions.slice(index + 1).join("；") || "当前为最后一个结构化恢复步骤"}`,
    "不得把工具错误直接当成任务终态；完成诊断、修复和复测后再关闭该恢复契约。",
  ].join("\n")
}
