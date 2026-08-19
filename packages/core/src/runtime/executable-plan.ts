import { createHash } from "node:crypto"
import type { ToolEffect } from "../tool/types.ts"
import type { ArtifactReference, TaskContract } from "./run-contract.ts"
import { normalizeTaskContract } from "./run-contract.ts"
import type { PlanContract, PlanNodeContract } from "./plan-contract.ts"

export interface ExecutablePlanIdentity {
  planId: string
  version: number
  fingerprint: string
}

export interface ExecutablePlanNode {
  nodeId: string
  dependsOn: readonly string[]
  assigneeAgentId: string
  taskContract: Readonly<TaskContract>
}

/**
 * Runtime-owned executable form of a submitted plan.
 *
 * The model-facing contract is parsed once. Every later delegation is compiled
 * from this frozen object rather than reparsing prompt text or trusting a
 * second model-authored copy of dependencies, resources or acceptance.
 */
export interface ExecutablePlan {
  identity: Readonly<ExecutablePlanIdentity>
  title: string
  contract: Readonly<PlanContract>
  nodes: readonly ExecutablePlanNode[]
}

export interface PlanNodeReference {
  planId: string
  version: number
  nodeId: string
}

export interface ExecutablePlanDagNode {
  id: string
  dependsOn: string[]
  resources: { reads: string[]; writes: string[] }
  payload: { planNodeId: string }
}

export function compileExecutablePlan(
  contract: PlanContract,
  workingDir: string,
): ExecutablePlan {
  const canonical = canonicalJson(contract)
  const identity = Object.freeze({
    planId: contract.planId,
    version: contract.version,
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
  })
  const sealedContract = deepFreeze(structuredClone(contract))
  const nodes = sealedContract.nodes.map((node) => Object.freeze({
    nodeId: node.nodeId,
    dependsOn: Object.freeze([...node.dependsOn]),
    assigneeAgentId: node.assigneeAgentId,
    taskContract: compilePlanNodeTaskContract(identity, node, workingDir),
  }))
  return Object.freeze({
    identity,
    title: sealedContract.title,
    contract: sealedContract,
    nodes: Object.freeze(nodes),
  })
}

export function resolveExecutablePlanNode(
  plan: ExecutablePlan,
  reference: PlanNodeReference,
): ExecutablePlanNode {
  if (reference.planId !== plan.identity.planId
    || reference.version !== plan.identity.version) {
    throw new Error(
      `计划引用已失效：当前权威计划为 ${plan.identity.planId}@${plan.identity.version}`,
    )
  }
  const node = plan.nodes.find((item) => item.nodeId === reference.nodeId)
  if (!node) throw new Error(`计划节点不存在: ${reference.nodeId}`)
  return node
}

/** Compile the exact scheduler graph; no model-authored graph copy is read. */
export function compileExecutablePlanDag(plan: ExecutablePlan): ExecutablePlanDagNode[] {
  return plan.nodes.map((node) => ({
    id: node.nodeId,
    dependsOn: [...node.dependsOn],
    resources: {
      reads: [...node.taskContract.resources.reads],
      writes: [...node.taskContract.resources.writes],
    },
    payload: { planNodeId: node.nodeId },
  }))
}

export function restrictToolsToExecutablePlan(
  toolNames: readonly string[],
  _plan?: ExecutablePlan,
): string[] {
  // A submitted plan is an auditable baseline, not an authority reduction.
  // User scope and tool policy continue to gate the returned surface.
  return [...toolNames]
}

export function instantiatePlannedTaskContract(input: {
  plan: ExecutablePlan
  reference: PlanNodeReference
  workingDir: string
  inputArtifacts?: ArtifactReference[]
  revisionOf?: string
  attempt?: number
  revisionInstructions?: string
}): TaskContract {
  const node = resolveExecutablePlanNode(input.plan, input.reference)
  const base = node.taskContract
  const contract = normalizeTaskContract({
    ...base,
    planRef: base.planRef,
    logicalTaskId: base.logicalTaskId,
    revisionOf: input.revisionOf,
    attempt: input.attempt,
    instructions: input.revisionInstructions
      ? `${base.instructions}\n\n上一次执行反馈：\n${input.revisionInstructions}`
      : base.instructions,
    inputArtifacts: [...base.inputArtifacts, ...(input.inputArtifacts ?? [])],
  }, input.workingDir)
  contract.acceptanceCriteria = base.acceptanceCriteria.map((criterion) => ({
    ...criterion,
    evidenceKinds: [...criterion.evidenceKinds],
    targetPatterns: [...criterion.targetPatterns],
    issuedAt: contract.issuedAt,
  }))
  return contract
}

export function assertPlanNodeInvocationMatches(input: {
  node: ExecutablePlanNode
  id?: unknown
  dependsOn?: unknown
  subagent?: unknown
  requiredEffects?: unknown
  reads?: unknown
  writes?: unknown
  acceptance?: unknown
  expectedOutputs?: unknown
}): void {
  if (typeof input.id === "string" && input.id.trim() !== input.node.nodeId) {
    throw new Error(`计划节点 ID 不可改写：应为 ${input.node.nodeId}`)
  }
  if (typeof input.subagent === "string"
    && input.subagent.trim() !== input.node.assigneeAgentId) {
    throw new Error(
      `计划节点 ${input.node.nodeId} 的执行角色不可改写：应为 ${input.node.assigneeAgentId}`,
    )
  }
  const contract = input.node.taskContract
  assertOptionalStringSet("depends_on", input.dependsOn, input.node.dependsOn)
  assertOptionalStringSet("required_effects", input.requiredEffects, contract.requiredEffects)
  assertOptionalStringSet("read_targets", input.reads, contract.resources.reads)
  assertOptionalStringSet("write_targets", input.writes, contract.resources.writes)
  assertOptionalStringSet("acceptance", input.acceptance, contract.acceptance)
  assertOptionalStringSet("expected_outputs", input.expectedOutputs, contract.expectedOutputs)
}

function compilePlanNodeTaskContract(
  identity: ExecutablePlanIdentity,
  node: Readonly<PlanNodeContract>,
  workingDir: string,
): Readonly<TaskContract> {
  const contract = normalizeTaskContract({
    planRef: {
      planId: identity.planId,
      version: identity.version,
      fingerprint: identity.fingerprint,
      nodeId: node.nodeId,
    },
    logicalTaskId: `${identity.planId}@${identity.version}:${node.nodeId}`,
    objective: node.title,
    instructions: node.instruction,
    constraints: node.dependsOn.length > 0
      ? [`仅在依赖节点完成验收后执行：${node.dependsOn.join(", ")}`]
      : [],
    acceptance: node.acceptance.map((item) => item.label),
    acceptanceCriteria: node.acceptance.map((requirement) => ({
      id: requirement.id,
      statement: requirement.label,
      verifier: requirement.verifier,
      evidenceKinds: [...requirement.anyOf],
      targetPatterns: [...requirement.targetPatterns],
      issuedAt: 0,
    })),
    expectedOutputs: [...node.expectedOutputs],
    requiredEffects: [...node.requiredEffects] as ToolEffect[],
    resources: {
      reads: [...node.resources.reads],
      writes: [...node.resources.writes],
    },
  }, workingDir)
  contract.acceptanceCriteria = node.acceptance.map((requirement) => ({
    id: requirement.id,
    statement: requirement.label,
    verifier: requirement.verifier,
    evidenceKinds: [...requirement.anyOf],
    targetPatterns: [...requirement.targetPatterns],
    issuedAt: contract.issuedAt,
  }))
  return deepFreeze(contract)
}

function assertOptionalStringSet(
  label: string,
  supplied: unknown,
  authoritative: readonly string[],
): void {
  if (supplied === undefined) return
  if (!Array.isArray(supplied)
    || supplied.some((item) => typeof item !== "string")) {
    throw new Error(`${label} 必须是字符串数组`)
  }
  const normalized = [...new Set(supplied.map((item) => item.trim()).filter(Boolean))].sort()
  const expected = [...new Set(authoritative)].sort()
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error(`${label} 与权威计划节点合同不一致`)
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}
