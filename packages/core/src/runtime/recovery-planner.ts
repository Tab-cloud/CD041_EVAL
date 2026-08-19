import type {
  ToolDiagnostic,
  ToolEffect,
  ToolRecoveryCandidate,
} from "../tool/types.ts"
import type { ToolExecutionOutcome } from "./agent-loop-control.ts"

export type RecoveryStrategyStatus = "available" | "active" | "failed" | "succeeded"

export interface RecoveryStrategyRecord {
  id: string
  failureFingerprint: string
  sourceTool: string
  summary: string
  status: RecoveryStrategyStatus
  attempts: number
  actionIndex: number
  actions: string[]
  actionTools: string[][]
  actionEffects: ToolEffect[][]
  evidence: string[]
  createdAt: number
  updatedAt: number
}

export interface RecoveryStrategyLedger {
  strategies: RecoveryStrategyRecord[]
}

/**
 * Produce recovery alternatives from typed diagnostic data. When a domain
 * tool has not supplied alternatives, the control plane still creates one
 * bounded inspect-and-retry strategy from execution semantics. No natural
 * language keyword is used to select tools or effects.
 */
export function planRecoveryStrategies(
  failure: ToolExecutionOutcome,
  fingerprint: string,
  now = Date.now(),
): RecoveryStrategyRecord[] {
  const diagnostic = failure.result.outcome?.diagnostic
  if (diagnostic?.retryable === false) return []
  const candidates = normalizeCandidates(diagnostic)
  const planned = candidates.length > 0
    ? candidates
    : genericCandidates(failure)
  return planned.map((candidate, index) => ({
    id: strategyId(fingerprint, candidate.id || `candidate-${index + 1}`),
    failureFingerprint: fingerprint,
    sourceTool: failure.name,
    summary: candidate.summary,
    status: "available",
    attempts: 0,
    actionIndex: 0,
    actions: candidate.steps.map((step) => step.instruction),
    actionTools: candidate.steps.map((step) =>
      [...new Set(step.tools?.map((tool) => tool.trim()).filter(Boolean) ?? [])]),
    actionEffects: candidate.steps.map((step) => [...new Set(step.effects ?? [])]),
    evidence: [...new Set(diagnostic?.evidence ?? [])].slice(0, 20),
    createdAt: now,
    updatedAt: now,
  }))
}

export function mergeRecoveryStrategies(
  ledger: RecoveryStrategyLedger | undefined,
  planned: RecoveryStrategyRecord[],
  maxEntries = 100,
): RecoveryStrategyLedger {
  const limit = Math.max(1, Math.floor(maxEntries))
  const strategies = [...(ledger?.strategies ?? [])].slice(0, limit)
  const known = new Set(strategies.map((strategy) => strategy.id))
  for (const strategy of planned) {
    if (strategies.length >= limit) break
    if (!known.has(strategy.id)) {
      strategies.push(strategy)
      known.add(strategy.id)
    }
  }
  return { strategies }
}

export function nextRecoveryStrategy(
  ledger: RecoveryStrategyLedger | undefined,
  failureFingerprint: string,
): RecoveryStrategyRecord | undefined {
  return ledger?.strategies.find((strategy) =>
    strategy.failureFingerprint === failureFingerprint
    && strategy.status === "available")
}

export function updateRecoveryStrategy(
  ledger: RecoveryStrategyLedger | undefined,
  id: string,
  update: Partial<RecoveryStrategyRecord>,
): RecoveryStrategyLedger | undefined {
  if (!ledger) return ledger
  return {
    strategies: ledger.strategies.map((strategy) =>
      strategy.id === id
        ? { ...strategy, ...update, updatedAt: Date.now() }
        : strategy),
  }
}

export function normalizeRecoveryLedger(value: unknown): RecoveryStrategyLedger {
  if (!isRecord(value) || !Array.isArray(value.strategies)) return { strategies: [] }
  const strategies = value.strategies.flatMap((entry): RecoveryStrategyRecord[] => {
    if (!isRecord(entry)
      || typeof entry.id !== "string"
      || typeof entry.failureFingerprint !== "string"
      || typeof entry.sourceTool !== "string"
      || !isStrategyStatus(entry.status)
      || !Array.isArray(entry.actions)) return []
    const actions = stringArray(entry.actions, 20, 2_000)
    if (actions.length === 0) return []
    return [{
      id: entry.id.slice(0, 600),
      failureFingerprint: entry.failureFingerprint.slice(0, 500),
      sourceTool: entry.sourceTool.slice(0, 128),
      summary: typeof entry.summary === "string"
        ? entry.summary.slice(0, 2_000)
        : "恢复策略",
      status: entry.status,
      attempts: finiteInteger(entry.attempts, 0),
      actionIndex: Math.min(actions.length - 1, finiteInteger(entry.actionIndex, 0)),
      actions,
      actionTools: normalizeStringMatrix(entry.actionTools, actions.length),
      actionEffects: normalizeEffectMatrix(entry.actionEffects, actions.length),
      evidence: stringArray(entry.evidence, 20, 2_000),
      createdAt: finiteInteger(entry.createdAt, Date.now()),
      updatedAt: finiteInteger(entry.updatedAt, Date.now()),
    }]
  })
  return { strategies: strategies.slice(-100) }
}

export function cloneRecoveryLedger(
  value: RecoveryStrategyLedger | undefined,
): RecoveryStrategyLedger | undefined {
  return value ? {
    strategies: value.strategies.map((strategy) => ({
      ...strategy,
      actions: [...strategy.actions],
      actionTools: strategy.actionTools.map((tools) => [...tools]),
      actionEffects: strategy.actionEffects.map((effects) => [...effects]),
      evidence: [...strategy.evidence],
    })),
  } : undefined
}

export function hasAvailableRecoveryStrategy(
  ledger: RecoveryStrategyLedger | undefined,
  failureFingerprint?: string,
): boolean {
  return Boolean(ledger?.strategies.some((strategy) =>
    strategy.status === "available"
    && (!failureFingerprint || strategy.failureFingerprint === failureFingerprint)))
}

function normalizeCandidates(diagnostic: ToolDiagnostic | undefined): ToolRecoveryCandidate[] {
  if (!diagnostic?.recoveryCandidates?.length) return []
  return diagnostic.recoveryCandidates.flatMap((candidate, index) => {
    const id = candidate.id?.trim().slice(0, 160) || `candidate-${index + 1}`
    const summary = candidate.summary?.trim().slice(0, 2_000) || "执行恢复策略"
    const steps = candidate.steps?.flatMap((step) => {
      const instruction = step.instruction?.trim().slice(0, 2_000)
      if (!instruction) return []
      return [{
        instruction,
        tools: stringArray(step.tools, 30, 128),
        effects: normalizeEffects(step.effects),
      }]
    }) ?? []
    return steps.length > 0 ? [{ id, summary, steps }] : []
  })
}

function genericCandidates(failure: ToolExecutionOutcome): ToolRecoveryCandidate[] {
  const inspectionEffects: ToolEffect[] = ["workspace-read"]
  const retryEffects = semanticEffects(failure)
  return [
    {
      id: "runtime-inspect-adjust-retry",
      summary: `核验 ${failure.name} 的输入与前置条件后，以调整后的方案重试`,
      steps: [
        {
          instruction: `收集 ${failure.name} 失败所需的缺失证据，核验输入、路径、依赖和当前状态`,
          effects: inspectionEffects,
        },
        {
          instruction: `根据新增证据调整调用方案并重新执行 ${failure.name}；不得原样重复失败参数`,
          tools: [failure.name],
          effects: retryEffects,
        },
      ],
    },
    {
      id: "runtime-alternative-capability",
      summary: `使用具备相同效果的其他已授权能力完成 ${failure.name} 的目标`,
      steps: [{
        instruction: `选择尚未用于本次失败的其他已授权工具或执行角色完成相同目标，并取得验收证据`,
        effects: retryEffects,
      }],
    },
  ]
}

function semanticEffects(failure: ToolExecutionOutcome): ToolEffect[] {
  if (failure.semantics.mutation) return ["workspace-write"]
  if (failure.semantics.verification) return ["process"]
  return ["workspace-read"]
}

function strategyId(fingerprint: string, candidateId: string): string {
  return `${fingerprint}:${candidateId}`.slice(0, 600)
}

function normalizeEffects(value: unknown): ToolEffect[] {
  if (!Array.isArray(value)) return []
  const valid = new Set<ToolEffect>([
    "workspace-read", "workspace-write", "process", "network",
    "hardware", "user-interaction", "delegation",
  ])
  return [...new Set(value.filter((effect): effect is ToolEffect =>
    typeof effect === "string" && valid.has(effect as ToolEffect)))]
}

function normalizeStringMatrix(value: unknown, rows: number): string[][] {
  if (!Array.isArray(value)) return Array.from({ length: rows }, () => [])
  return Array.from({ length: rows }, (_, index) =>
    stringArray(value[index], 30, 128))
}

function normalizeEffectMatrix(value: unknown, rows: number): ToolEffect[][] {
  if (!Array.isArray(value)) return Array.from({ length: rows }, () => [])
  return Array.from({ length: rows }, (_, index) => normalizeEffects(value[index]))
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems)
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback
}

function isStrategyStatus(value: unknown): value is RecoveryStrategyStatus {
  return value === "available" || value === "active"
    || value === "failed" || value === "succeeded"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
