import type { ToolEffect } from "../tool/types.ts"
import type { ExecutionScope } from "./tool-policy.ts"

export type ObjectiveGoalType =
  | "plan" | "build" | "debug" | "hardware" | "ui" | "documentation" | "research" | "implementation" | "general"

export const OBJECTIVE_GOAL_TYPES = [
  "plan",
  "build",
  "debug",
  "hardware",
  "ui",
  "documentation",
  "research",
  "implementation",
  "general",
] as const satisfies readonly ObjectiveGoalType[]

export const OBJECTIVE_TOOL_EFFECTS = [
  "workspace-read",
  "workspace-write",
  "process",
  "network",
  "hardware",
  "user-interaction",
  "delegation",
] as const satisfies readonly ToolEffect[]

export type ObjectiveEvidenceKind =
  | "plan-submission"
  | "build-success"
  | "test-success"
  | "regression-test-success"
  | "stress-test-success"
  | "schematic-inspection"
  | "datasheet-inspection"
  | "source-inspection"
  | "workspace-inspection"
  | "external-research"
  | "workspace-mutation"
  | "process-verification"
  | "hardware-observation"

export const OBJECTIVE_EVIDENCE_KINDS = [
  "plan-submission",
  "build-success",
  "test-success",
  "regression-test-success",
  "stress-test-success",
  "schematic-inspection",
  "datasheet-inspection",
  "source-inspection",
  "workspace-inspection",
  "external-research",
  "workspace-mutation",
  "process-verification",
  "hardware-observation",
] as const satisfies readonly ObjectiveEvidenceKind[]

export type ObjectiveVerifier =
  | "plan"
  | "build"
  | "process"
  | "test"
  | "regression-test"
  | "stress-test"
  | "source-inspection"
  | "workspace-inspection"
  | "research"
  | "mutation"
  | "hardware"

export const OBJECTIVE_VERIFIERS = [
  "plan",
  "build",
  "process",
  "test",
  "regression-test",
  "stress-test",
  "source-inspection",
  "workspace-inspection",
  "research",
  "mutation",
  "hardware",
] as const satisfies readonly ObjectiveVerifier[]

const GOAL_TYPES = new Set<string>(OBJECTIVE_GOAL_TYPES)
const TOOL_EFFECTS = new Set<string>(OBJECTIVE_TOOL_EFFECTS)
const EVIDENCE_KINDS = new Set<string>(OBJECTIVE_EVIDENCE_KINDS)
const VERIFIERS = new Set<string>(OBJECTIVE_VERIFIERS)

export const OBJECTIVE_EVIDENCE_BY_VERIFIER: Record<ObjectiveVerifier, ReadonlySet<ObjectiveEvidenceKind>> = {
  plan: new Set(["plan-submission"]),
  build: new Set(["build-success"]),
  process: new Set(["process-verification"]),
  test: new Set(["test-success"]),
  "regression-test": new Set(["regression-test-success"]),
  "stress-test": new Set(["stress-test-success"]),
  "source-inspection": new Set(["source-inspection"]),
  "workspace-inspection": new Set([
    "workspace-inspection",
    "source-inspection",
    "schematic-inspection",
    "datasheet-inspection",
  ]),
  research: new Set([
    "external-research",
    "datasheet-inspection",
    "schematic-inspection",
    "workspace-inspection",
  ]),
  mutation: new Set(["workspace-mutation"]),
  hardware: new Set([
    "hardware-observation",
    "schematic-inspection",
    "datasheet-inspection",
  ]),
}

export interface ObjectiveEvidenceRequirement {
  id: string
  label: string
  anyOf: ObjectiveEvidenceKind[]
  verifier: ObjectiveVerifier
  targetPatterns: string[]
}

/**
 * Semantic-model acceptance input.
 *
 * The model describes only the evidence that may satisfy one requirement.
 * `verifier` is deliberately absent: it is a runtime execution concern and
 * must not be redundantly guessed by the model.
 */
export interface SemanticObjectiveEvidenceRequirement {
  id: string
  label: string
  anyOf: ObjectiveEvidenceKind[]
  targetPatterns: string[]
}

/** Runtime-owned acceptance contract. Model-authored todos cannot weaken it. */
export interface ObjectiveAcceptancePolicy {
  requirements: ObjectiveEvidenceRequirement[]
}

/**
 * Validated meaning supplied by the semantic analysis boundary.
 *
 * This structure, not the original prose, owns role, capability and acceptance
 * decisions. Internal callers and tests must construct it explicitly.
 */
export interface StructuredObjectiveIntent {
  goalType: ObjectiveGoalType
  requiredEffects: ToolEffect[]
  candidateAgentIds: string[]
  requiresPlanning: boolean
  acceptanceRequirements: ObjectiveEvidenceRequirement[]
}

export interface ObjectiveIntent {
  goalType: ObjectiveGoalType
  requiredEffects: ToolEffect[]
  artifacts: string[]
  constraints: string[]
  acceptance: string[]
  candidateAgentIds: string[]
  requiresEvidence: boolean
  acceptancePolicy?: ObjectiveAcceptancePolicy
}

export class StructuredObjectiveIntentRequiredError extends Error {
  readonly code = "structured-objective-intent-required"

  constructor() {
    super("目标编译需要已验证的结构化语义意图，禁止从自然语言关键词推断权限、角色或验收")
    this.name = "StructuredObjectiveIntentRequiredError"
  }
}

/**
 * Compile a validated semantic protocol into an execution contract.
 *
 * The user message is deliberately not inspected here. The only deterministic
 * additions are phase facts owned by the runtime: an automatic planning phase
 * needs delegation, and its plan submission is enforced by execution-flow.
 * Effects observed from real tool calls are governed dynamically by the
 * execution controller rather than guessed from prose.
 */
export function compileObjective(
  _message: string,
  scope: ExecutionScope,
  options: {
    autoPlanning?: boolean
    planContinuation?: boolean
    semanticAnalysis?: StructuredObjectiveIntent
  } = {},
): ObjectiveIntent {
  if (!options.semanticAnalysis) throw new StructuredObjectiveIntentRequiredError()

  const semantic = normalizeStructuredObjectiveIntent(options.semanticAnalysis)
  const requiredEffects = new Set<ToolEffect>(semantic.requiredEffects)
  // `requiresPlanning` is a semantic recommendation. Delegation becomes a
  // runtime obligation only when the routing authority actually admits an
  // automatic planning phase. Otherwise a model-side complexity judgment can
  // accidentally turn a direct response into a mandatory tool protocol.
  if (options.autoPlanning) requiredEffects.add("delegation")

  const goalType = scope === "plan-mode" ? "plan" : semantic.goalType
  // The execution-flow contract owns the transient planning acceptance. Keep
  // that reserved ID out of the later execution objective so a model cannot
  // replace it and the completed plan is not requested a second time.
  const requirements = options.autoPlanning
    ? semantic.acceptanceRequirements.filter((item) => item.id !== "plan")
    : semantic.acceptanceRequirements
  const artifacts = [...new Set(requirements.flatMap((item) => item.targetPatterns))].slice(0, 50)

  return {
    goalType,
    requiredEffects: [...requiredEffects],
    artifacts,
    constraints: [],
    acceptance: requirements.map((item) => item.label),
    candidateAgentIds: semantic.candidateAgentIds,
    requiresEvidence: scope !== "plan-mode" && requirements.length > 0,
    acceptancePolicy: requirements.length > 0 ? { requirements } : undefined,
  }
}

export function normalizeStructuredObjectiveIntent(
  input: StructuredObjectiveIntent,
): StructuredObjectiveIntent {
  if (!GOAL_TYPES.has(input.goalType)) throw new Error(`未知 goalType: ${String(input.goalType)}`)
  if (!Array.isArray(input.requiredEffects) || input.requiredEffects.length > OBJECTIVE_TOOL_EFFECTS.length) {
    throw new Error("requiredEffects 必须是有效工具效果数组")
  }
  const requiredEffects = input.requiredEffects.map((effect) => {
    if (typeof effect !== "string" || !TOOL_EFFECTS.has(effect)) {
      throw new Error(`requiredEffects 包含未知工具效果: ${String(effect)}`)
    }
    return effect
  })
  if (!Array.isArray(input.candidateAgentIds) || input.candidateAgentIds.length < 1
    || input.candidateAgentIds.length > 8) {
    throw new Error("candidateAgentIds 必须包含 1 到 8 个 Agent")
  }
  const candidateAgentIds = input.candidateAgentIds.map((id) => {
    if (typeof id !== "string" || !id.trim()) throw new Error("candidateAgentIds 包含无效 ID")
    return id.trim()
  })
  if (typeof input.requiresPlanning !== "boolean") {
    throw new Error("requiresPlanning 必须是布尔值")
  }
  const modelRequirements = normalizeObjectiveEvidenceRequirements(input.acceptanceRequirements)
  const acceptanceRequirements = enforceEffectEvidenceFloors(requiredEffects, modelRequirements)
  assertEffectEvidenceCoverage(requiredEffects, acceptanceRequirements)
  return {
    goalType: input.goalType,
    requiredEffects: [...new Set(requiredEffects)],
    candidateAgentIds: [...new Set(candidateAgentIds)],
    requiresPlanning: input.requiresPlanning,
    acceptanceRequirements,
  }
}

/**
 * Normalize the strict semantic-model protocol into the runtime contract.
 *
 * Evidence kinds are the single semantic source of truth. The runtime derives
 * a compatible verifier deterministically, using goalType only to resolve
 * genuinely ambiguous local schematic/datasheet evidence. This removes the
 * former model-authored verifier/anyOf consistency problem without weakening
 * any effect or acceptance floor.
 */
export function normalizeSemanticObjectiveIntent(
  input: Omit<StructuredObjectiveIntent, "acceptanceRequirements"> & {
    acceptanceRequirements: unknown
  },
): StructuredObjectiveIntent {
  if (!GOAL_TYPES.has(input.goalType)) throw new Error(`未知 goalType: ${String(input.goalType)}`)
  const acceptanceRequirements = normalizeSemanticObjectiveEvidenceRequirements(
    input.goalType,
    input.acceptanceRequirements,
  )
  return normalizeStructuredObjectiveIntent({
    ...input,
    acceptanceRequirements,
  })
}

/**
 * Tool effects are already validated structured facts. Their mechanical
 * acceptance lower bounds are runtime policy, not semantic-model judgment.
 * The model still owns domain-specific acceptance (for example schematic or
 * source inspection), while the runtime injects evidence that can never be
 * omitted to make an operation easier to complete.
 */
function enforceEffectEvidenceFloors(
  effects: ToolEffect[],
  requirements: ObjectiveEvidenceRequirement[],
): ObjectiveEvidenceRequirement[] {
  const result = [...requirements]
  const hasVerifier = (...verifiers: ObjectiveVerifier[]) =>
    result.some((item) => verifiers.includes(item.verifier))
  const add = (
    id: string,
    label: string,
    verifier: ObjectiveVerifier,
    anyOf: ObjectiveEvidenceKind[],
  ) => {
    if (result.length >= 20) {
      throw new Error("运行时强制验收要求超过 20 项，请减少模型生成的重复验收条件")
    }
    let uniqueId = id
    let suffix = 2
    while (result.some((item) => item.id === uniqueId)) uniqueId = `${id}-${suffix++}`
    result.push({ id: uniqueId, label, verifier, anyOf, targetPatterns: [] })
  }

  if (effects.includes("workspace-read")
    && !hasVerifier("source-inspection", "workspace-inspection", "research")) {
    add(
      "runtime-workspace-inspection",
      "运行时读取并检查目标工作区内容",
      "workspace-inspection",
      ["workspace-inspection"],
    )
  }
  if (effects.includes("workspace-write")) {
    if (!hasVerifier("mutation")) {
      add("runtime-workspace-mutation", "运行时确认工作区发生预期变更", "mutation", ["workspace-mutation"])
    }
    if (!result.some((item) => item.verifier !== "mutation")) {
      add(
        "runtime-workspace-verification",
        "运行时独立检查变更后的工作区",
        "workspace-inspection",
        ["workspace-inspection"],
      )
    }
  }
  if (effects.includes("process")
    && !hasVerifier("process", "build", "test", "regression-test", "stress-test")) {
    add("runtime-process-verification", "运行时验证执行进程结果", "process", ["process-verification"])
  }
  if (effects.includes("hardware") && !hasVerifier("hardware")) {
    add("runtime-hardware-verification", "运行时记录硬件操作观测", "hardware", ["hardware-observation"])
  }
  if (effects.includes("network") && !hasVerifier("research")) {
    add("runtime-network-research", "运行时记录外部资料检索证据", "research", ["external-research"])
  }
  return result
}

export function normalizeObjectiveEvidenceRequirements(
  value: unknown,
): ObjectiveEvidenceRequirement[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("acceptanceRequirements 必须是最多 20 项的数组")
  }
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`acceptanceRequirements[${index}] 不是对象`)
    }
    const record = item as Record<string, unknown>
    assertExactKeys(
      record,
      ["id", "label", "verifier", "anyOf", "targetPatterns"],
      `acceptanceRequirements[${index}]`,
    )
    const id = requiredString(record.id, `acceptanceRequirements[${index}].id`, 200)
    if (ids.has(id)) throw new Error(`acceptanceRequirements id 重复: ${id}`)
    ids.add(id)
    const label = requiredString(record.label, `acceptanceRequirements[${index}].label`, 1_000)
    if (typeof record.verifier !== "string" || !VERIFIERS.has(record.verifier)) {
      throw new Error(`acceptanceRequirements[${index}].verifier 无效`)
    }
    const verifier = record.verifier as ObjectiveVerifier
    if (!Array.isArray(record.anyOf) || record.anyOf.length < 1 || record.anyOf.length > 10) {
      throw new Error(`acceptanceRequirements[${index}].anyOf 无效`)
    }
    const anyOf = record.anyOf.map((kind) => {
      if (typeof kind !== "string" || !EVIDENCE_KINDS.has(kind)) {
        throw new Error(`acceptanceRequirements[${index}].anyOf 包含未知证据类型`)
      }
      if (!OBJECTIVE_EVIDENCE_BY_VERIFIER[verifier].has(kind as ObjectiveEvidenceKind)) {
        throw new Error(`证据 ${kind} 与 verifier ${verifier} 不兼容`)
      }
      return kind as ObjectiveEvidenceKind
    })
    if (!Array.isArray(record.targetPatterns) || record.targetPatterns.length > 50
      || record.targetPatterns.some((target) => typeof target !== "string" || target.length > 500)) {
      throw new Error(`acceptanceRequirements[${index}].targetPatterns 无效`)
    }
    return {
      id,
      label,
      verifier,
      anyOf: [...new Set(anyOf)],
      targetPatterns: [...new Set((record.targetPatterns as string[])
        .map((target) => target.trim().replace(/\\/g, "/").toLowerCase())
        .filter(Boolean))],
    }
  })
}

export function normalizeSemanticObjectiveEvidenceRequirements(
  goalType: ObjectiveGoalType,
  value: unknown,
): ObjectiveEvidenceRequirement[] {
  if (!GOAL_TYPES.has(goalType)) throw new Error(`未知 goalType: ${String(goalType)}`)
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("acceptanceRequirements 必须是最多 20 项的数组")
  }
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`acceptanceRequirements[${index}] 不是对象`)
    }
    const record = item as Record<string, unknown>
    assertExactKeys(
      record,
      ["id", "label", "anyOf", "targetPatterns"],
      `acceptanceRequirements[${index}]`,
    )
    const id = requiredString(record.id, `acceptanceRequirements[${index}].id`, 200)
    if (ids.has(id)) throw new Error(`acceptanceRequirements id 重复: ${id}`)
    ids.add(id)
    const label = requiredString(record.label, `acceptanceRequirements[${index}].label`, 1_000)
    if (!Array.isArray(record.anyOf) || record.anyOf.length < 1 || record.anyOf.length > 10) {
      throw new Error(`acceptanceRequirements[${index}].anyOf 无效`)
    }
    const anyOf = [...new Set(record.anyOf.map((kind) => {
      if (typeof kind !== "string" || !EVIDENCE_KINDS.has(kind)) {
        throw new Error(`acceptanceRequirements[${index}].anyOf 包含未知证据类型`)
      }
      return kind as ObjectiveEvidenceKind
    }))]
    if (!Array.isArray(record.targetPatterns) || record.targetPatterns.length > 50
      || record.targetPatterns.some((target) => typeof target !== "string" || target.length > 500)) {
      throw new Error(`acceptanceRequirements[${index}].targetPatterns 无效`)
    }
    return {
      id,
      label,
      verifier: deriveObjectiveVerifier(goalType, anyOf, index),
      anyOf,
      targetPatterns: [...new Set((record.targetPatterns as string[])
        .map((target) => target.trim().replace(/\\/g, "/").toLowerCase())
        .filter(Boolean))],
    }
  })
}

const DIRECT_VERIFIER_BY_EVIDENCE: Partial<Record<ObjectiveEvidenceKind, ObjectiveVerifier>> = {
  "plan-submission": "plan",
  "build-success": "build",
  "test-success": "test",
  "regression-test-success": "regression-test",
  "stress-test-success": "stress-test",
  "source-inspection": "source-inspection",
  "workspace-inspection": "workspace-inspection",
  "external-research": "research",
  "workspace-mutation": "mutation",
  "process-verification": "process",
  "hardware-observation": "hardware",
}

function deriveObjectiveVerifier(
  goalType: ObjectiveGoalType,
  anyOf: ObjectiveEvidenceKind[],
  requirementIndex: number,
): ObjectiveVerifier {
  const candidates = OBJECTIVE_VERIFIERS.filter((verifier) =>
    anyOf.every((kind) => OBJECTIVE_EVIDENCE_BY_VERIFIER[verifier].has(kind)))
  if (candidates.length === 0) {
    throw new Error(
      `acceptanceRequirements[${requirementIndex}].anyOf 无法由同一个运行时 verifier 验证`,
    )
  }

  if (anyOf.length === 1) {
    const direct = DIRECT_VERIFIER_BY_EVIDENCE[anyOf[0]!]
    if (direct && candidates.includes(direct)) return direct
  }

  const ambiguousPreference: ObjectiveVerifier[] = goalType === "hardware"
    ? ["hardware", "workspace-inspection", "research"]
    : goalType === "research"
      ? ["research", "workspace-inspection", "hardware"]
      : ["workspace-inspection", "research", "hardware"]
  return ambiguousPreference.find((verifier) => candidates.includes(verifier))
    ?? candidates[0]!
}

function assertEffectEvidenceCoverage(
  effects: ToolEffect[],
  requirements: ObjectiveEvidenceRequirement[],
): void {
  const verifiers = new Set(requirements.map((item) => item.verifier))
  const requireVerifier = (effect: ToolEffect, accepted: ObjectiveVerifier[]) => {
    if (!effects.includes(effect) || accepted.some((verifier) => verifiers.has(verifier))) return
    throw new Error(
      `requiredEffects ${effect} 缺少兼容的验收 verifier（需要 ${accepted.join(" 或 ")}）`,
    )
  }
  requireVerifier("workspace-write", ["mutation"])
  requireVerifier("workspace-read", [
    "source-inspection",
    "workspace-inspection",
    "research",
  ])
  if (effects.includes("workspace-write")
    && !requirements.some((item) => item.verifier !== "mutation")) {
    throw new Error("workspace-write 除 mutation 外还必须包含独立验证要求")
  }
  requireVerifier("process", ["process", "build", "test", "regression-test", "stress-test"])
  requireVerifier("hardware", ["hardware"])
  requireVerifier("network", ["research"])
}

function assertExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys)
  const actual = Object.keys(record)
  const unknown = actual.filter((key) => !allowed.has(key))
  const missing = keys.filter((key) => !Object.hasOwn(record, key))
  if (unknown.length || missing.length) {
    throw new Error(`${label}字段不符合协议：缺少 [${missing.join(", ")}]，未知 [${unknown.join(", ")}]`)
  }
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${label} 必须是 1 到 ${maxLength} 字符的字符串`)
  }
  return value.trim()
}
