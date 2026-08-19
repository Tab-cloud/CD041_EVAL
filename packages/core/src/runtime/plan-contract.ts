import type { ToolEffect } from "../tool/types.ts"
import {
  normalizeSemanticObjectiveEvidenceRequirements,
  normalizeStructuredObjectiveIntent,
  OBJECTIVE_EVIDENCE_KINDS,
  OBJECTIVE_GOAL_TYPES,
  type ObjectiveEvidenceRequirement,
  type ObjectiveGoalType,
} from "./objective-compiler.ts"
import {
  normalizeResourceClaims,
  type ResourceClaims,
} from "./run-contract.ts"

export const PLAN_SCHEMA_VERSION = 1 as const

export type PlanBlockingClass =
  | "none"
  | "user-decision"
  | "permission"
  | "hardware"
  | "external-service"

export interface PlanNodeContract {
  nodeId: string
  title: string
  instruction: string
  goalType: ObjectiveGoalType
  dependsOn: string[]
  assigneeAgentId: string
  requiredEffects: ToolEffect[]
  resources: ResourceClaims
  acceptance: ObjectiveEvidenceRequirement[]
  expectedOutputs: string[]
  blockingClass: PlanBlockingClass
}

/**
 * Runtime-authoritative plan. Public Markdown is always derived from this
 * contract and never used to schedule or accept work.
 */
export interface PlanContract {
  schemaVersion: typeof PLAN_SCHEMA_VERSION
  planId: string
  version: number
  title: string
  nodes: PlanNodeContract[]
}

const EFFECTS = new Set<ToolEffect>([
  "workspace-read",
  "workspace-write",
  "process",
  "network",
  "hardware",
  "user-interaction",
  "delegation",
])

const BLOCKING_CLASSES = new Set<PlanBlockingClass>([
  "none",
  "user-decision",
  "permission",
  "hardware",
  "external-service",
])

export const PLAN_CONTRACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: PLAN_SCHEMA_VERSION },
    planId: { type: "string", minLength: 1, maxLength: 128 },
    version: { type: "integer", minimum: 1, maximum: 1_000_000 },
    title: { type: "string", minLength: 1, maxLength: 100 },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          nodeId: { type: "string", minLength: 1, maxLength: 128 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          instruction: { type: "string", minLength: 1, maxLength: 4_000 },
          goalType: { type: "string", enum: OBJECTIVE_GOAL_TYPES },
          dependsOn: {
            type: "array",
            maxItems: 50,
            items: { type: "string", minLength: 1, maxLength: 128 },
          },
          assigneeAgentId: { type: "string", minLength: 1, maxLength: 128 },
          requiredEffects: {
            type: "array",
            minItems: 1,
            maxItems: 7,
            items: { type: "string", enum: [...EFFECTS] },
          },
          resources: {
            type: "object",
            additionalProperties: false,
            properties: {
              reads: {
                type: "array",
                maxItems: 100,
                items: { type: "string", minLength: 1, maxLength: 1_000 },
              },
              writes: {
                type: "array",
                maxItems: 100,
                items: { type: "string", minLength: 1, maxLength: 1_000 },
              },
            },
            required: ["reads", "writes"],
          },
          acceptance: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 200 },
                label: { type: "string", minLength: 1, maxLength: 1_000 },
                anyOf: {
                  type: "array",
                  minItems: 1,
                  maxItems: 10,
                  items: { type: "string", enum: OBJECTIVE_EVIDENCE_KINDS },
                },
                targetPatterns: {
                  type: "array",
                  maxItems: 50,
                  items: { type: "string", maxLength: 500 },
                },
              },
              required: ["id", "label", "anyOf", "targetPatterns"],
            },
          },
          expectedOutputs: {
            type: "array",
            minItems: 0,
            maxItems: 50,
            items: { type: "string", minLength: 1, maxLength: 1_000 },
            description: "Durable file artifacts only. Use an empty array when acceptance evidence is the deliverable.",
          },
          blockingClass: {
            type: "string",
            enum: [...BLOCKING_CLASSES],
          },
        },
        required: [
          "nodeId",
          "title",
          "instruction",
          "goalType",
          "dependsOn",
          "assigneeAgentId",
          "requiredEffects",
          "resources",
          "acceptance",
          "expectedOutputs",
          "blockingClass",
        ],
      },
    },
  },
  required: ["schemaVersion", "planId", "version", "title", "nodes"],
} as const

export function normalizePlanContract(value: unknown, workingDir: string): PlanContract {
  const input = record(value, "contract")
  exactKeys(input, ["schemaVersion", "planId", "version", "title", "nodes"], "contract")
  if (input.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`contract.schemaVersion 必须为 ${PLAN_SCHEMA_VERSION}`)
  }
  const planId = identifier(input.planId, "contract.planId")
  const version = positiveInteger(input.version, "contract.version")
  const title = text(input.title, "contract.title", 100)
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 50) {
    throw new Error("contract.nodes 必须包含 1 到 50 个节点")
  }
  const nodes = input.nodes.map((node, index) => normalizeNode(node, index, workingDir))
  validateGraph(nodes)
  return { schemaVersion: PLAN_SCHEMA_VERSION, planId, version, title, nodes }
}

export function renderPlanContractMarkdown(contract: PlanContract): string {
  return contract.nodes.map((node, index) => {
    const dependencies = node.dependsOn.length ? node.dependsOn.join(", ") : "无"
    const reads = node.resources.reads.length ? node.resources.reads.join(", ") : "无"
    const writes = node.resources.writes.length ? node.resources.writes.join(", ") : "无"
    return [
      `### ${index + 1}. ${node.title}（${node.nodeId}）`,
      node.instruction,
      `- 目标类型：${node.goalType}`,
      `- 执行角色：${node.assigneeAgentId}`,
      `- 前置节点：${dependencies}`,
      `- 所需能力：${node.requiredEffects.join(", ")}`,
      `- 读取资源：${reads}`,
      `- 写入资源：${writes}`,
      `- 阻塞类别：${node.blockingClass}`,
      "- 验收条件：",
      ...node.acceptance.map((item) =>
        `  - [${item.id}] ${item.label}（${item.verifier}: ${item.anyOf.join(" | ")}）`),
      "- 预期输出：",
      ...node.expectedOutputs.map((item) => `  - ${item}`),
    ].join("\n")
  }).join("\n\n")
}

export function serializePlanContractForExecution(contract: PlanContract): string {
  return JSON.stringify(contract)
}

function normalizeNode(value: unknown, index: number, workingDir: string): PlanNodeContract {
  const label = `contract.nodes[${index}]`
  const input = record(value, label)
  exactKeys(input, [
    "nodeId",
    "title",
    "instruction",
    "goalType",
    "dependsOn",
    "assigneeAgentId",
    "requiredEffects",
    "resources",
    "acceptance",
    "expectedOutputs",
    "blockingClass",
  ], label)
  const nodeId = identifier(input.nodeId, `${label}.nodeId`)
  const title = text(input.title, `${label}.title`, 200)
  const instruction = text(input.instruction, `${label}.instruction`, 4_000)
  if (typeof input.goalType !== "string"
    || !(OBJECTIVE_GOAL_TYPES as readonly string[]).includes(input.goalType)) {
    throw new Error(`${label}.goalType 无效`)
  }
  const goalType = input.goalType as ObjectiveGoalType
  const dependsOn = stringList(input.dependsOn, `${label}.dependsOn`, 50, 128)
    .map((item) => identifier(item, `${label}.dependsOn`))
  const assigneeAgentId = identifier(input.assigneeAgentId, `${label}.assigneeAgentId`)
  const requiredEffects = effectList(input.requiredEffects, `${label}.requiredEffects`)
  const resourcesInput = record(input.resources, `${label}.resources`)
  exactKeys(resourcesInput, ["reads", "writes"], `${label}.resources`)
  const resources = normalizeResourceClaims(resourcesInput, workingDir)
  if (resources.reads.some((item) => item.startsWith("external:"))
    || resources.writes.some((item) => item.startsWith("external:"))) {
    throw new Error(`${label}.resources 不得超出当前工作区`)
  }
  if (requiredEffects.includes("workspace-read") && resources.reads.length === 0) {
    throw new Error(`${label} 声明 workspace-read 时必须列出 resources.reads`)
  }
  if (requiredEffects.includes("workspace-write") && resources.writes.length === 0) {
    throw new Error(`${label} 声明 workspace-write 时必须列出 resources.writes`)
  }
  if (!Array.isArray(input.acceptance) || input.acceptance.length === 0) {
    throw new Error(`${label}.acceptance 不能为空`)
  }
  const semanticAcceptance = normalizeSemanticObjectiveEvidenceRequirements(goalType, input.acceptance)
  const acceptance = normalizeStructuredObjectiveIntent({
    goalType,
    requiredEffects,
    candidateAgentIds: [assigneeAgentId],
    requiresPlanning: false,
    acceptanceRequirements: semanticAcceptance,
  }).acceptanceRequirements
  if (acceptance.length === 0) throw new Error(`${label}.acceptance 不能为空`)
  const expectedOutputs = stringList(
    input.expectedOutputs,
    `${label}.expectedOutputs`,
    50,
    1_000,
  )
  if (typeof input.blockingClass !== "string"
    || !BLOCKING_CLASSES.has(input.blockingClass as PlanBlockingClass)) {
    throw new Error(`${label}.blockingClass 无效`)
  }
  return {
    nodeId,
    title,
    instruction,
    goalType,
    dependsOn: [...new Set(dependsOn)],
    assigneeAgentId,
    requiredEffects,
    resources,
    acceptance,
    expectedOutputs,
    blockingClass: input.blockingClass as PlanBlockingClass,
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) {
    throw new Error(`${label} 必须是 1 到 1000000 的整数`)
  }
  return Number(value)
}

function validateGraph(nodes: PlanNodeContract[]): void {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.nodeId)) throw new Error(`contract.nodes 的 nodeId 重复: ${node.nodeId}`)
    ids.add(node.nodeId)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.nodeId) throw new Error(`节点 ${node.nodeId} 不能依赖自身`)
      if (!ids.has(dependency)) {
        throw new Error(`节点 ${node.nodeId} 引用了不存在的依赖 ${dependency}`)
      }
    }
  }
  const remaining = new Map(nodes.map((node) => [node.nodeId, new Set(node.dependsOn)]))
  let resolved = 0
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([nodeId]) => nodeId)
    if (ready.length === 0) throw new Error("contract.nodes 存在循环依赖")
    for (const nodeId of ready) remaining.delete(nodeId)
    for (const dependencies of remaining.values()) {
      for (const nodeId of ready) dependencies.delete(nodeId)
    }
    resolved += ready.length
  }
  if (resolved !== nodes.length) throw new Error("contract.nodes 拓扑校验失败")
}

function effectList(value: unknown, label: string): ToolEffect[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > EFFECTS.size) {
    throw new Error(`${label} 必须包含 1 到 ${EFFECTS.size} 个工具效果`)
  }
  return [...new Set(value.map((effect) => {
    if (typeof effect !== "string" || !EFFECTS.has(effect as ToolEffect)) {
      throw new Error(`${label} 包含未知工具效果: ${String(effect)}`)
    }
    return effect as ToolEffect
  }))]
}

function stringList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} 必须是最多 ${maximumItems} 项的数组`)
  }
  return [...new Set(value.map((item) => text(item, label, maximumLength)))]
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) {
    throw new Error(`${label} 只能包含字母、数字、点、下划线和连字符`)
  }
  return result
}

function text(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximumLength) {
    throw new Error(`${label} 必须是 1 到 ${maximumLength} 字符的字符串`)
  }
  return value.trim()
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(record).filter((key) => !allowed.has(key))
  const missing = keys.filter((key) => !Object.hasOwn(record, key))
  if (unknown.length || missing.length) {
    throw new Error(`${label} 字段不符合协议：缺少 [${missing.join(", ")}]，未知 [${unknown.join(", ")}]`)
  }
}
