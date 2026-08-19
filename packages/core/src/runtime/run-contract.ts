import { resolve, relative } from "node:path"
import type { ToolExecutionView } from "../store/tool-execution.ts"
import type { ToolEffect } from "../tool/types.ts"
import type {
  ObjectiveEvidenceKind,
  ObjectiveVerifier,
} from "./objective-compiler.ts"
import {
  OBJECTIVE_EVIDENCE_BY_VERIFIER,
  OBJECTIVE_VERIFIERS as OBJECTIVE_VERIFIER_VALUES,
} from "./objective-compiler.ts"
import {
  evidenceTargetMatches,
  normalizeEvidenceTarget,
} from "./evidence-targets.ts"

export interface ArtifactReference {
  kind: "file" | "tool-execution" | "execution-evidence" | "run-result"
  ref: string
  label?: string
  /** Runtime-derived semantics. Model-authored labels are never trusted. */
  evidenceKinds?: ObjectiveEvidenceKind[]
  targets?: string[]
  observedAt?: number
}

export interface ResourceClaims {
  reads: string[]
  writes: string[]
}

export interface TaskContract {
  /** Immutable link to the runtime-owned plan node that issued this task. */
  planRef?: {
    planId: string
    version: number
    fingerprint: string
    nodeId: string
  }
  logicalTaskId?: string
  revisionOf?: string
  attempt?: number
  objective: string
  instructions: string
  constraints: string[]
  acceptance: string[]
  acceptanceCriteria: AcceptanceCriterion[]
  inputArtifacts: ArtifactReference[]
  expectedOutputs: string[]
  /** Runtime-validated effects the assigned child must be able to perform. */
  requiredEffects: ToolEffect[]
  resources: ResourceClaims
  issuedAt: number
}

export interface AcceptanceCriterion {
  id: string
  statement: string
  verifier: ObjectiveVerifier
  evidenceKinds: ObjectiveEvidenceKind[]
  targetPatterns: string[]
  issuedAt: number
}

export type TaskResultStatus = "completed" | "failed" | "blocked" | "interrupted" | "cancelled"

export interface TaskResult {
  status: TaskResultStatus
  summary: string
  output: string
  artifacts: ArtifactReference[]
  evidence: ArtifactReference[]
  unresolved: string[]
  completedAt: number
}

export interface AcceptanceCheck {
  criterionId?: string
  criterion: string
  status: "passed" | "failed"
  evidenceRefs: string[]
  conclusion: string
}

export function normalizeTaskContract(
  input: Partial<TaskContract> & Pick<TaskContract, "objective" | "instructions">,
  workingDir: string,
): TaskContract {
  const issuedAt = Date.now()
  // Acceptance is an internal runtime policy, never a mandatory model field.
  // A simple delegated reasoning task may legitimately have no hard evidence
  // contract; operational root objectives are still verified by the root
  // execution controller from real tool outcomes.
  const acceptance = strings(input.acceptance, 20, 1_000)
  const resources = normalizeResourceClaims(input.resources, workingDir)
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    input.acceptanceCriteria,
    acceptance,
    issuedAt,
  )
  return {
    planRef: normalizePlanReference(input.planRef),
    logicalTaskId: typeof input.logicalTaskId === "string" ? bounded(input.logicalTaskId, 200) : undefined,
    revisionOf: typeof input.revisionOf === "string" ? bounded(input.revisionOf, 200) : undefined,
    attempt: typeof input.attempt === "number" ? Math.max(1, Math.floor(input.attempt)) : undefined,
    objective: bounded(input.objective, 2_000),
    instructions: bounded(input.instructions, 20_000),
    constraints: strings(input.constraints, 20, 1_000),
    acceptance,
    acceptanceCriteria,
    inputArtifacts: normalizeArtifacts(input.inputArtifacts),
    expectedOutputs: strings(input.expectedOutputs, 20, 1_000),
    requiredEffects: deriveTaskRequiredEffects({
      declared: input.requiredEffects,
      resources,
      acceptanceCriteria,
      inputArtifacts: input.inputArtifacts,
    }),
    resources,
    issuedAt,
  }
}

/**
 * A rejected attempt may refine its plan, but it cannot weaken the original
 * objective, acceptance metadata or resource declaration.
 */
export function normalizeTaskContractRevision(
  previous: TaskContract,
  input: Partial<TaskContract> & Pick<TaskContract, "instructions">,
  workingDir: string,
): TaskContract {
  const suppliedPlanRef = normalizePlanReference(input.planRef)
  if (suppliedPlanRef && !samePlanReference(suppliedPlanRef, previous.planRef)) {
    throw new Error("修订任务不得更换原计划身份或节点")
  }
  const next = normalizeTaskContract({
    ...input,
    planRef: previous.planRef,
    objective: previous.objective,
    logicalTaskId: previous.logicalTaskId,
    constraints: unionStrings(previous.constraints, input.constraints),
    acceptance: unionStrings(previous.acceptance, input.acceptance),
    inputArtifacts: uniqueArtifactReferences([
      ...previous.inputArtifacts,
      ...(input.inputArtifacts ?? []),
    ]),
    expectedOutputs: unionStrings(previous.expectedOutputs, input.expectedOutputs),
    requiredEffects: unionToolEffects(previous.requiredEffects, input.requiredEffects),
    resources: {
      reads: unionStrings(previous.resources.reads, input.resources?.reads),
      writes: unionStrings(previous.resources.writes, input.resources?.writes),
    },
  }, workingDir)
  next.logicalTaskId = previous.logicalTaskId
  next.planRef = previous.planRef
  // A revision is a new evidence epoch. Earlier tool executions cannot be
  // rebound to the new attempt's acceptance checks.
  next.issuedAt = Date.now()
  next.acceptanceCriteria = normalizeAcceptanceCriteria(
    [
      ...(previous.acceptanceCriteria ?? []),
      ...(Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []),
    ],
    next.acceptance,
    next.issuedAt,
  )
  return next
}

function normalizePlanReference(value: unknown): TaskContract["planRef"] {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("planRef 必须是对象")
  }
  const input = value as Record<string, unknown>
  const keys = ["planId", "version", "fingerprint", "nodeId"]
  if (Object.keys(input).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(input, key))) {
    throw new Error("planRef 字段不完整或包含未知字段")
  }
  const string = (key: "planId" | "fingerprint" | "nodeId") => {
    const current = input[key]
    if (typeof current !== "string" || !current.trim()) throw new Error(`planRef.${key} 无效`)
    return bounded(current, key === "fingerprint" ? 128 : 200)
  }
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 1) {
    throw new Error("planRef.version 无效")
  }
  return {
    planId: string("planId"),
    version: Number(input.version),
    fingerprint: string("fingerprint"),
    nodeId: string("nodeId"),
  }
}

function samePlanReference(
  left: TaskContract["planRef"],
  right: TaskContract["planRef"],
): boolean {
  if (!left || !right) return left === right
  return left.planId === right.planId
    && left.version === right.version
    && left.fingerprint === right.fingerprint
    && left.nodeId === right.nodeId
}

export function deriveAcceptanceChecks(
  contract: TaskContract,
  result: TaskResult,
): AcceptanceCheck[] {
  const references = [...result.evidence, ...result.artifacts]
  return acceptanceCriteria(contract).map((criterion) => {
    const evidenceRefs = references
      .filter((item) => evidenceSatisfiesCriterion(item, criterion))
      .map((item) => item.ref)
      .slice(0, 20)
    return {
      criterionId: criterion.id,
      criterion: criterion.statement,
      status: evidenceRefs.length > 0 ? "passed" : "failed",
      evidenceRefs,
      conclusion: evidenceRefs.length > 0
        ? `已由 ${criterion.verifier} 类型证据支持`
        : `缺少 ${criterion.verifier} 类型且目标/时序匹配的证据`,
    }
  })
}

export function normalizeResourceClaims(input: Partial<ResourceClaims> | undefined, workingDir: string): ResourceClaims {
  return {
    reads: normalizeResources(input?.reads, workingDir),
    writes: normalizeResources(input?.writes, workingDir),
  }
}

export function renderTaskContract(contract: TaskContract): string {
  return [
    "[TaskContract]",
    `目标：${contract.objective}`,
    `执行指令：${contract.instructions}`,
    contract.constraints.length ? `约束：\n${contract.constraints.map((item) => `- ${item}`).join("\n")}` : "",
    contract.acceptance.length ? `验收条件：\n${acceptanceCriteria(contract).map((item) =>
      `- [${item.id}] ${item.statement}（verifier=${item.verifier}${item.targetPatterns.length ? `, targets=${item.targetPatterns.join(",")}` : ""}）`)
      .join("\n")}` : "",
    contract.inputArtifacts.length
      ? `输入引用：\n${contract.inputArtifacts.map((item) => `- ${item.kind}:${item.ref}${item.label ? ` (${item.label})` : ""}`).join("\n")}`
      : "",
    contract.expectedOutputs.length ? `预期输出：\n${contract.expectedOutputs.map((item) => `- ${item}`).join("\n")}` : "",
    contract.requiredEffects.length ? `所需工具效果：${contract.requiredEffects.join(", ")}` : "",
    "请返回结论、产物引用、真实工具结果和未解决事项；不得只返回过程描述。",
  ].filter(Boolean).join("\n\n")
}

const TASK_TOOL_EFFECTS = new Set<ToolEffect>([
  "workspace-read",
  "workspace-write",
  "process",
  "network",
  "hardware",
  "user-interaction",
  "delegation",
])

function deriveTaskRequiredEffects(input: {
  declared?: ToolEffect[]
  resources: ResourceClaims
  acceptanceCriteria: AcceptanceCriterion[]
  inputArtifacts?: ArtifactReference[]
}): ToolEffect[] {
  const effects = new Set<ToolEffect>(
    Array.isArray(input.declared)
      ? input.declared.filter((effect): effect is ToolEffect => TASK_TOOL_EFFECTS.has(effect))
      : [],
  )
  if (input.resources.reads.length > 0 || (input.inputArtifacts?.length ?? 0) > 0) {
    effects.add("workspace-read")
  }
  if (input.resources.writes.length > 0) effects.add("workspace-write")
  for (const criterion of input.acceptanceCriteria) {
    if (["source-inspection", "workspace-inspection"].includes(criterion.verifier)) {
      effects.add("workspace-read")
    } else if (["build", "process", "test", "regression-test", "stress-test"].includes(criterion.verifier)) {
      effects.add("process")
    } else if (criterion.verifier === "research") {
      effects.add("network")
    } else if (criterion.verifier === "mutation") {
      effects.add("workspace-write")
    } else if (criterion.verifier === "hardware") {
      effects.add("hardware")
    }
  }
  return [...effects]
}

function unionToolEffects(
  left: ToolEffect[] | undefined,
  right: ToolEffect[] | undefined,
): ToolEffect[] {
  return [...new Set([
    ...(left ?? []),
    ...(right ?? []),
  ].filter((effect): effect is ToolEffect => TASK_TOOL_EFFECTS.has(effect)))]
}

export function artifactReferencesFromExecutions(
  executions: ToolExecutionView[],
): ArtifactReference[] {
  return uniqueArtifactReferences(executions.flatMap((item) => item.status === "succeeded" && item.filePath
    ? [{
        kind: "file" as const,
        ref: item.filePath,
        label: item.toolName,
        evidenceKinds: ["write", "edit"].includes(item.toolName)
          ? ["workspace-mutation" as const]
          : [],
        targets: [normalizeEvidenceTarget(item.filePath)],
        observedAt: item.finishedAt ?? item.startedAt,
      }]
    : []))
}

export function evidenceReferencesFromExecutions(
  executions: ToolExecutionView[],
  additionalRefs: string[] = [],
): ArtifactReference[] {
  return uniqueArtifactReferences([
    ...executions.filter((item) => item.status === "succeeded").map((item) => ({
      kind: "tool-execution" as const,
      ref: item.id,
      label: item.toolName,
      evidenceKinds: classifyExecutionEvidence(item),
      targets: executionTargets(item),
      observedAt: item.finishedAt ?? item.startedAt,
    })),
    ...additionalRefs.map((ref) => ({
      kind: "execution-evidence" as const,
      ref,
      // Text summaries remain useful context, but deliberately have no typed
      // verifier and therefore cannot satisfy a hard acceptance criterion.
      evidenceKinds: [],
      targets: [],
    })),
  ])
}

export function expectedOutputsSatisfied(
  expectedOutputs: string[],
  artifacts: ArtifactReference[],
): boolean {
  if (expectedOutputs.length === 0) return true
  return expectedOutputs.every((expected) => {
    const pattern = normalizeEvidenceTarget(expected)
    return artifacts.some((artifact) => {
      if (artifact.kind !== "file") return false
      const candidates = [artifact.ref, ...(artifact.targets ?? [])].map(normalizeEvidenceTarget)
      return candidates.some((candidate) => evidenceTargetMatches(candidate, pattern))
    })
  })
}

function acceptanceCriteria(contract: TaskContract): AcceptanceCriterion[] {
  if (Array.isArray(contract.acceptanceCriteria) && contract.acceptanceCriteria.length > 0) {
    return contract.acceptanceCriteria
  }
  const issuedAt = Number.isFinite(contract.issuedAt) ? contract.issuedAt : 0
  return contract.acceptance.map((statement, index) =>
    compileAcceptanceCriterion(statement, index, issuedAt, "process", []))
}

function compileAcceptanceCriterion(
  statement: string,
  index: number,
  issuedAt: number,
  verifier: ObjectiveVerifier,
  targetPatterns: string[],
): AcceptanceCriterion {
  return {
    id: `criterion-${index + 1}`,
    statement,
    verifier,
    evidenceKinds: verifierEvidenceKinds(verifier),
    targetPatterns,
    issuedAt,
  }
}

function normalizeAcceptanceCriteria(
  value: unknown,
  statements: string[],
  issuedAt: number,
): AcceptanceCriterion[] {
  const supplied = Array.isArray(value) ? value : []
  return statements.map((statement, index) => {
    const raw = supplied.find((item) =>
      item && typeof item === "object"
      && ((item as Record<string, unknown>).statement === statement
        || (item as Record<string, unknown>).id === `criterion-${index + 1}`)) as Record<string, unknown> | undefined
    const verifier = isObjectiveVerifier(raw?.verifier) ? raw.verifier : "process"
    const targets = Array.isArray(raw?.targetPatterns)
      ? raw.targetPatterns.filter((item): item is string => typeof item === "string")
        .map(normalizeEvidenceTarget).filter(Boolean).slice(0, 50)
      : []
    return compileAcceptanceCriterion(statement, index, issuedAt, verifier, targets)
  })
}

function isObjectiveVerifier(value: unknown): value is ObjectiveVerifier {
  return typeof value === "string" && OBJECTIVE_VERIFIERS.has(value as ObjectiveVerifier)
}

function verifierEvidenceKinds(verifier: ObjectiveVerifier): ObjectiveEvidenceKind[] {
  return [...OBJECTIVE_EVIDENCE_BY_VERIFIER[verifier]]
}

function evidenceSatisfiesCriterion(
  evidence: ArtifactReference,
  criterion: AcceptanceCriterion,
): boolean {
  if (typeof evidence.observedAt !== "number" || evidence.observedAt < criterion.issuedAt) return false
  if (!(evidence.evidenceKinds ?? []).some((kind) => criterion.evidenceKinds.includes(kind))) return false
  if (criterion.targetPatterns.length === 0) return true
  const targets = [evidence.ref, ...(evidence.targets ?? [])].map(normalizeEvidenceTarget)
  return criterion.targetPatterns.every((pattern) =>
    targets.some((target) => evidenceTargetMatches(target, pattern)))
}

function classifyExecutionEvidence(execution: ToolExecutionView): ObjectiveEvidenceKind[] {
  const name = execution.toolName
  const kinds = new Set<ObjectiveEvidenceKind>()
  if (["write", "edit", "project_init", "chip_add", "lvgl_gen", "write_office"].includes(name)) {
    kinds.add("workspace-mutation")
  }
  for (const attestation of execution.runtimeEvidence ?? []) kinds.add(attestation.kind)
  if (name === "plan") kinds.add("plan-submission")
  if (name === "schematic_read") kinds.add("schematic-inspection")
  if (name === "datasheet_read") kinds.add("datasheet-inspection")
  if (name === "websearch" || name === "webfetch") kinds.add("external-research")
  if (isDurableHardwareObservation(execution)) {
    kinds.add("hardware-observation")
  }
  if (["read", "grep", "glob"].includes(name)) {
    kinds.add("workspace-inspection")
    if (executionTargets(execution).some(isSourceTarget)) kinds.add("source-inspection")
  }
  return [...kinds]
}

/**
 * Keep durable diagnostic evidence identical to the live objective ledger.
 * A control action proves that a command was issued, not that hardware state
 * was observed. Verified flash results are persisted as runtime attestations
 * and are therefore handled by the loop above rather than inferred by name.
 */
function isDurableHardwareObservation(execution: ToolExecutionView): boolean {
  const action = typeof execution.input.action === "string"
    ? execution.input.action
    : ""
  if (execution.toolName === "usb_detect") {
    return action === "list" || action === "hid-list"
  }
  if (execution.toolName === "serial_monitor") return true
  if (execution.toolName === "serial_open") {
    return action === "list" || action === "receive"
  }
  if (execution.toolName === "swd_debug") {
    if (action === "connect" || action === "regs" || action === "memory") {
      return true
    }
    return action === "breakpoints"
      && (!Array.isArray(execution.input.breakpoints)
        || execution.input.breakpoints.length === 0)
  }
  return false
}

function executionTargets(execution: ToolExecutionView): string[] {
  const keys = [
    "path", "paths", "projectDir", "outputDir", "firmwarePath", "file", "cwd",
  ]
  return [...new Set([
    ...(execution.runtimeEvidence ?? []).flatMap((item) => item.targets),
    ...keys.flatMap((key) => {
    const value = execution.input[key]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
    return typeof value === "string" ? [value] : []
    }),
  ].map(normalizeEvidenceTarget).filter(Boolean))]
}

function isSourceTarget(target: string): boolean {
  return /(?:^|\/)(?:src|source|code|firmware|include|inc|lib)(?:\/|$)/.test(target)
    || /\.(?:c|h|cc|cpp|cxx|hpp|s|asm|ld|mk|rs|go|py|java|kt|swift|ts|tsx|js|jsx|vue|svelte)$/.test(target)
}

export function resourcesConflict(left: ResourceClaims | undefined, right: ResourceClaims | undefined): boolean {
  if (!left || !right) return false
  return intersects(left.writes, [...right.reads, ...right.writes])
    || intersects(right.writes, [...left.reads, ...left.writes])
}

function intersects(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => resourceOverlap(a, b)))
}

function resourceOverlap(left: string, right: string): boolean {
  if (left === "workspace:**" || right === "workspace:**") return true
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function normalizeResources(value: unknown, workingDir: string): string[] {
  return [...new Set(strings(value, 100, 1_000).map((item) => {
    if (item === "workspace:**") return item
    const path = relative(resolve(workingDir), resolve(workingDir, item)).replace(/\\/g, "/").toLowerCase()
    return path && !path.startsWith("../") ? path : `external:${item.toLowerCase()}`
  }))]
}

function normalizeArtifacts(value: unknown): ArtifactReference[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const raw = item as Record<string, unknown>
    const kind = raw.kind
    if (!["file", "tool-execution", "execution-evidence", "run-result"].includes(String(kind))) return []
    if (typeof raw.ref !== "string" || !raw.ref.trim()) return []
    return [{
      kind: kind as ArtifactReference["kind"],
      ref: bounded(raw.ref, 2_000),
      label: typeof raw.label === "string" ? bounded(raw.label, 500) : undefined,
      evidenceKinds: Array.isArray(raw.evidenceKinds)
        ? raw.evidenceKinds.filter((item): item is ObjectiveEvidenceKind =>
            typeof item === "string" && EVIDENCE_KINDS.has(item as ObjectiveEvidenceKind))
        : undefined,
      targets: Array.isArray(raw.targets)
        ? raw.targets.filter((item): item is string => typeof item === "string")
          .map(normalizeEvidenceTarget).slice(0, 100)
        : undefined,
      observedAt: typeof raw.observedAt === "number" && Number.isFinite(raw.observedAt)
        ? raw.observedAt
        : undefined,
    }]
  }).slice(0, 100)
}

function uniqueArtifactReferences(items: ArtifactReference[]): ArtifactReference[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.kind}:${item.ref}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function unionStrings(left: unknown, right: unknown): string[] {
  return [...new Set([
    ...(Array.isArray(left) ? left.filter((item): item is string => typeof item === "string") : []),
    ...(Array.isArray(right) ? right.filter((item): item is string => typeof item === "string") : []),
  ])]
}

function strings(value: unknown, maxItems: number, maxChars: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => bounded(item, maxChars)).slice(0, maxItems)
    : []
}

function bounded(value: string, max: number): string {
  return value.trim().slice(0, max)
}

const EVIDENCE_KINDS = new Set<ObjectiveEvidenceKind>([
  "plan-submission", "build-success", "test-success",
  "regression-test-success", "stress-test-success",
  "schematic-inspection", "datasheet-inspection", "source-inspection",
  "workspace-inspection", "external-research", "workspace-mutation",
  "process-verification", "hardware-observation",
])

const OBJECTIVE_VERIFIERS = new Set<ObjectiveVerifier>(OBJECTIVE_VERIFIER_VALUES)
