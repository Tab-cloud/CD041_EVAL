import type { ToolEffect } from "../tool/types.ts"
import type {
  ExecutionRecoveryDirective,
  ToolExecutionOutcome,
} from "./agent-loop-control.ts"
import { isRecord } from "./agent-loop-control-normalization.ts"

export function normalizeRecoveryDirective(
  value: unknown,
): ExecutionRecoveryDirective | undefined {
  if (!isRecord(value)
    || typeof value.strategyId !== "string"
    || typeof value.fingerprint !== "string"
    || typeof value.sourceTool !== "string"
    || typeof value.kind !== "string"
    || !Array.isArray(value.actions)) return
  const actions = value.actions
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 2_000))
    .filter(Boolean)
    .slice(0, 20)
  if (actions.length === 0) return
  return {
    strategyId: value.strategyId.slice(0, 600),
    fingerprint: value.fingerprint.slice(0, 500),
    sourceTool: value.sourceTool.slice(0, 128),
    kind: value.kind.slice(0, 200),
    summary: typeof value.summary === "string"
      ? value.summary.slice(0, 2_000)
      : "工具执行失败",
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, 2_000)).slice(0, 20)
      : [],
    actions,
    actionTools: normalizeRecoveryMatrix(value.actionTools, actions.length),
    actionEffects: normalizeRecoveryEffects(value.actionEffects, actions.length),
    actionIndex: Math.min(
      actions.length - 1,
      Math.max(0, typeof value.actionIndex === "number" ? Math.floor(value.actionIndex) : 0),
    ),
    attempts: Math.max(
      1,
      typeof value.attempts === "number" ? Math.floor(value.attempts) : 1,
    ),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  }
}

export function cloneRecoveryDirective(
  value: ExecutionRecoveryDirective | undefined,
): ExecutionRecoveryDirective | undefined {
  return value ? {
    ...value,
    evidence: [...value.evidence],
    actions: [...value.actions],
    actionTools: value.actionTools?.map((tools) => [...tools]),
    actionEffects: value.actionEffects?.map((effects) => [...effects]),
  } : undefined
}

export function recoveryActionSatisfied(
  recovery: ExecutionRecoveryDirective,
  outcome: ToolExecutionOutcome,
): boolean {
  if (!outcome.result.success) return false
  const tools = recovery.actionTools?.[recovery.actionIndex] ?? []
  const effects = recovery.actionEffects?.[recovery.actionIndex] ?? []
  if (tools.length > 0 && !tools.includes(outcome.name)) return false
  if (effects.length > 0) {
    return effects.every((effect) => effectSatisfied(effect, tools, outcome))
  }
  if (tools.length > 0) return true
  return outcome.semantics.mutation || outcome.semantics.verification
}

/**
 * Effects which cannot be proven from generic progress semantics require an
 * exact tool identity supplied by the typed recovery candidate. A successful
 * read is therefore never accepted as process, network, or hardware recovery.
 */
function effectSatisfied(
  effect: ToolEffect,
  expectedTools: string[],
  outcome: ToolExecutionOutcome,
): boolean {
  if (effect === "workspace-write") return outcome.semantics.mutation
  if (effect === "workspace-read") {
    return outcome.semantics.verification
      && !outcome.semantics.mutation
      && targetsObserved(outcome)
  }
  if (effect === "user-interaction") {
    return expectedTools.length > 0 && outcome.name === "question"
  }
  if (effect === "delegation") {
    return expectedTools.length > 0
      && (outcome.name === "task" || outcome.name === "delegate_dag")
  }
  if (effect === "process") {
    return expectedTools.length > 0 && processEvidence(outcome)
  }
  if (effect === "network" || effect === "hardware") {
    return expectedTools.length > 0
      && actualToolEffects(outcome).includes(effect)
      && outcome.semantics.verification
      && targetsObserved(outcome)
  }
  return false
}

function actualToolEffects(outcome: ToolExecutionOutcome): readonly ToolEffect[] {
  return Array.isArray(outcome.toolEffects) ? outcome.toolEffects : []
}

function targetsObserved(outcome: ToolExecutionOutcome): boolean {
  return outcome.semantics.globalVerification
    || outcome.semantics.verificationTargets.length > 0
}

function processEvidence(outcome: ToolExecutionOutcome): boolean {
  if (outcome.result.outcome?.category === "build"
    || outcome.result.outcome?.category === "command") return true
  return Boolean(outcome.result.outcome?.evidence?.some((item) =>
    item.kind === "build-success"
    || item.kind === "test-success"
    || item.kind === "regression-test-success"
    || item.kind === "stress-test-success"
    || item.kind === "process-verification"))
}

function normalizeRecoveryMatrix(
  value: unknown,
  actionCount: number,
): string[][] | undefined {
  if (!Array.isArray(value)) return undefined
  return Array.from({ length: actionCount }, (_, index) => {
    const row = value[index]
    return Array.isArray(row)
      ? [...new Set(row.filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 128)).filter(Boolean))]
      : []
  })
}

function normalizeRecoveryEffects(
  value: unknown,
  actionCount: number,
): ToolEffect[][] | undefined {
  if (!Array.isArray(value)) return undefined
  const valid = new Set<ToolEffect>([
    "workspace-read",
    "workspace-write",
    "process",
    "network",
    "hardware",
    "user-interaction",
    "delegation",
  ])
  return Array.from({ length: actionCount }, (_, index) => {
    const row = value[index]
    return Array.isArray(row)
      ? [...new Set(row.filter((item): item is ToolEffect =>
        typeof item === "string" && valid.has(item as ToolEffect)))]
      : []
  })
}
