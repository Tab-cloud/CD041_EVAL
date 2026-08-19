import { randomUUID } from "node:crypto"
import { MAIN_AGENT_ID } from "../../agent/definitions/main-agent.ts"
import {
  executeDelegationDag,
  type DelegationDagNode,
  type DelegationDagNodeResult,
  validateDelegationDag,
} from "../../runtime/delegation-dag.ts"
import { logOrchestrationEvent } from "../../runtime/orchestration-log.ts"
import {
  normalizeResourceClaims,
  normalizeTaskContract,
} from "../../runtime/run-contract.ts"
import { runGraphService } from "../../runtime/run-graph.ts"
import { taskScheduler } from "../../runtime/task-scheduler.ts"
import { unsupportedTaskEffects } from "../../runtime/task-capability.ts"
import { RunGraphRepo } from "../../store/run-graph.ts"
import { defineTool } from "../define.ts"
import type { ToolEffect, ToolResult } from "../types.ts"
import { taskTool } from "./task.ts"
import {
  assertPlanNodeInvocationMatches,
  compileExecutablePlanDag,
  resolveExecutablePlanNode,
  type ExecutablePlan,
} from "../../runtime/executable-plan.ts"

interface DagToolNode {
  id?: string
  description?: string
  subagent?: string
  plan_node_id?: string
  prompt?: string
  depends_on?: string[]
  resource_claims?: { reads?: string[]; writes?: string[] }
  constraints?: string[]
  acceptance?: string[]
  acceptance_criteria?: unknown[]
  expected_outputs?: string[]
  required_effects?: ToolEffect[]
}

interface DagNodePayload {
  input: ResolvedDagToolNode
}

interface ResolvedDagToolNode extends DagToolNode {
  id: string
  description: string
  subagent: string
  acceptance: string[]
}

export const delegateDagTool = defineTool({
  name: "delegate_dag",
  description: `一次委派多个原子子任务。模型只描述节点、角色、指令和依赖；
   运行时校验 Agent、编译资源与完成状态，独立节点并行，有依赖节点按序执行。
   单个节点失败会作为结果返回；独立分支继续，依赖该节点的分支自动跳过。`,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      nodes: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            description: { type: "string", minLength: 1, maxLength: 2_000 },
            subagent: { type: "string", minLength: 1, maxLength: 100 },
            prompt: { type: "string", maxLength: 20_000 },
            depends_on: { type: "array", items: { type: "string" }, maxItems: 12 },
          },
          required: ["id", "description", "subagent"],
        },
      },
    },
    required: ["nodes"],
  },
  async execute({
    nodes: submittedNodes,
    plan_id,
    plan_version,
  }: {
    nodes: DagToolNode[]
    plan_id?: string
    plan_version?: number
  }, ctx): Promise<ToolResult> {
    if (ctx.runType !== "root" || ctx.agentId !== MAIN_AGENT_ID) {
      return { success: false, error: "只有当前会话的主 Agent 可以创建委派 DAG" }
    }
    if (!ctx.agentRegistry || !ctx.toolRegistry || !ctx.modelRouter) {
      return { success: false, error: "委派 DAG 需要完整的 Agent 运行时依赖" }
    }
    let rawNodes: ResolvedDagToolNode[]
    try {
      rawNodes = resolveDagToolNodes({
        submittedNodes,
        activePlan: ctx.activePlan,
        planId: plan_id,
        planVersion: plan_version,
      })
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    const plannedInvocation = Boolean(ctx.activePlan
      && (plan_id !== undefined
        || plan_version !== undefined
        || submittedNodes.some((node) => node.plan_node_id !== undefined)))

    // Graph structure is the outer contract. Validate IDs, dependencies and
    // cycles before inspecting any assignee capability so an invalid graph is
    // never misreported as an agent/tool mismatch.
    const parentRunId = ctx.runId ?? ctx.sessionId
    const groupId = `delegation-dag-${randomUUID()}`
    const childRunIds = new Map<string, string>()
    const nodes: DelegationDagNode<DagNodePayload>[] = plannedInvocation
      ? compileExecutablePlanDag(ctx.activePlan!).map((node) => ({
          id: node.id,
          dependsOn: node.dependsOn,
          resources: node.resources,
          payload: { input: rawNodes.find((item) => item.id === node.id)! },
        }))
      : rawNodes.map((node) => ({
          id: node.id,
          dependsOn: uniqueStrings(node.depends_on),
          resources: normalizeResourceClaims({
            reads: node.resource_claims?.reads,
            writes: node.resource_claims?.writes,
          }, ctx.workingDir),
          payload: { input: node },
        }))
    try {
      validateDelegationDag(nodes)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }

    for (const node of rawNodes) {
      const agent = ctx.agentRegistry.get(node.subagent)
      if (!agent) return { success: false, error: `节点 ${node.id} 指定的子 Agent 不存在: ${node.subagent}` }
      if (agent.mode === "primary") {
        return { success: false, error: `节点 ${node.id} 不能把主 Agent 作为子 Agent 启动` }
      }
      const preview = normalizeTaskContract({
        objective: node.description,
        instructions: node.prompt?.trim() || node.description,
        constraints: node.constraints,
        acceptance: node.acceptance,
        acceptanceCriteria: node.acceptance_criteria as any,
        expectedOutputs: node.expected_outputs,
        requiredEffects: node.required_effects,
        resources: {
          reads: node.resource_claims?.reads ?? [],
          writes: node.resource_claims?.writes ?? [],
        },
      }, ctx.workingDir)
      const unsupported = unsupportedTaskEffects({
        agent,
        tools: ctx.toolRegistry,
        requiredEffects: preview.requiredEffects,
        scope: ctx.scope ?? "auto-edit",
        policy: ctx.toolPolicy,
        workingDir: ctx.workingDir,
      })
      if (unsupported.length > 0) {
        return {
          success: false,
          error: `节点 ${node.id} 的子 Agent "${agent.id}" 无法满足工具效果：${unsupported.join(", ")}`,
          outcome: {
            status: "failed",
            category: "generic",
            summary: "委派图能力预检失败，主 Agent 仍保留任务所有权",
            fingerprint: `delegate-dag-capability:${node.id}:${agent.id}:${unsupported.sort().join(",")}`,
            diagnostic: {
              kind: "delegation-dag-capability-mismatch",
              evidence: unsupported.map((effect) => `unsupported:${effect}`),
              nextActions: ["主 Agent 调整节点边界、改选角色、直接执行或重拟委派图"],
              retryable: false,
              failureDisposition: "continue",
            },
          },
        }
      }
    }

    logOrchestrationEvent({
      sessionId: ctx.sessionId,
      runId: parentRunId,
      agentId: ctx.agentId,
      eventType: "delegation.dag-requested",
      message: "主 Agent 提交原子委派 DAG",
      data: { groupId, nodeCount: nodes.length, visibility: "internal" },
    })

    let dagResult
    try {
      dagResult = await executeDelegationDag<DagNodePayload, ToolResult>(nodes, {
        suspendParent: () => taskScheduler.waitForDelegation(
          parentRunId,
          `等待 ${nodes.length} 个原子子任务完成`,
        ),
        resumeParent: () => resumeParent(parentRunId, ctx.abortSignal),
        runNode: async (node, signal, dependencyResults) => {
          const input = node.payload.input
          const dependencyArtifacts = [...dependencyResults.values()].flatMap((result) => {
            const data = toolResultData(result.value)
            return data?.resultRef ? [{
              kind: "run-result",
              ref: data.resultRef,
              label: `依赖节点 ${result.nodeId} 的结果`,
            }] : []
          })
          const result = await taskTool.execute({
              plan_id: plannedInvocation ? ctx.activePlan?.identity.planId : undefined,
              plan_version: plannedInvocation ? ctx.activePlan?.identity.version : undefined,
              plan_node_id: plannedInvocation ? input.id : undefined,
              subagent_name: input.subagent,
              description: input.description,
              prompt: input.prompt?.trim() || input.description,
              constraints: input.constraints,
              acceptance: input.acceptance,
              acceptance_criteria: input.acceptance_criteria,
              input_artifacts: dependencyArtifacts,
              expected_outputs: input.expected_outputs,
              required_effects: input.required_effects,
              read_targets: node.resources.reads,
              write_targets: node.resources.writes,
            }, {
              ...ctx,
              abortSignal: signal,
              delegationGroup: {
                id: groupId,
                parentGateOwned: true,
                onChildScheduled: (runId) => {
                  childRunIds.set(node.id, runId)
                  const graphId = RunGraphRepo.graphIdForNode(runId)
                  if (!graphId) return
                  for (const dependency of node.dependsOn) {
                    const dependencyRunId = childRunIds.get(dependency)
                    if (dependencyRunId) {
                      runGraphService.addEdge(graphId, runId, dependencyRunId, "depends-on")
                    }
                  }
                },
              },
            })
          if (!result.success) {
            return {
              nodeId: node.id,
              success: false,
              value: result,
              error: result.error,
            } satisfies DelegationDagNodeResult<ToolResult>
          }
          return {
            nodeId: node.id,
            success: true,
            value: result,
          } satisfies DelegationDagNodeResult<ToolResult>
        },
        cancelNode: async (nodeId) => {
          const runId = childRunIds.get(nodeId)
          if (!runId) return "exited"
          taskScheduler.cancel(runId)
          return waitForWorkerExit(runId, 5_000)
        },
      }, ctx.abortSignal, { cancellationJoinMs: 6_000 })
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const results = dagResult.results.map((result) => {
      const value = result.value
      const data = toolResultData(value)
      return {
        nodeId: result.nodeId,
        success: result.success,
        runId: data?.runId,
        logicalTaskId: data?.logicalTaskId,
        status: result.skipped ? "skipped" : data?.status ?? (result.success ? "completed" : "failed"),
        resultRef: data?.resultRef,
        error: result.error ?? value?.error,
      }
    })
    if (!dagResult.success) {
      if (ctx.abortSignal?.aborted || dagResult.failedNodeId === "cancelled") {
        return {
          success: false,
          error: "委派 DAG 已随父任务取消",
          data: { groupId, status: "cancelled", results },
          outcome: {
            status: "cancelled",
            category: "generic",
            summary: "委派 DAG 已取消并完成 Worker 汇合",
          },
        }
      }
      const failed = results.filter((result) => !result.success && result.status !== "skipped")
      const skipped = results.filter((result) => result.status === "skipped")
      const summary = `委派 DAG 已返回部分结果：${failed.length} 个节点失败，${skipped.length} 个依赖节点跳过，其余独立节点已继续完成`
      return {
        success: true,
        data: { groupId, status: "partial", results },
        outcome: {
          status: "succeeded",
          category: "evidence",
          summary,
        },
      }
    }

    return {
      success: true,
      data: {
        groupId,
        status: "completed",
        results,
      },
    }
  },
  contract: {
    effects: ["delegation"],
    runtimeDependencies: { modelCapabilities: ["chat"] },
    idempotency: "non-idempotent",
    cancellation: "cooperative",
    progress: { role: "delegation" },
  },
  permission: "task",
})

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
}

function toolResultData(value: ToolResult | undefined): Record<string, any> | undefined {
  return value?.data && typeof value.data === "object"
    ? value.data as Record<string, any>
    : undefined
}

async function resumeParent(parentRunId: string, signal?: AbortSignal): Promise<void> {
  try { await taskScheduler.resumeDelegationAndWait(parentRunId, signal) }
  catch { /* Parent cancellation already has a durable scheduler state. */ }
}

async function waitForWorkerExit(runId: string, timeoutMs: number): Promise<"exited" | "pending"> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() <= deadline) {
    const status = taskScheduler.getTask(runId)?.status
    if (!status || !["queued", "running", "cancelling", "waiting-approval", "waiting-delegation"].includes(status)) {
      return "exited"
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return "pending"
}

function resolveDagToolNodes(input: {
  submittedNodes: DagToolNode[]
  activePlan?: ExecutablePlan
  planId?: string
  planVersion?: number
}): ResolvedDagToolNode[] {
  if (!Array.isArray(input.submittedNodes) || input.submittedNodes.length === 0) {
    throw new Error("delegate_dag.nodes 必须包含至少一个节点")
  }
  const hasPlanReference = input.planId !== undefined || input.planVersion !== undefined
    || input.submittedNodes.some((node) => node.plan_node_id !== undefined)
  if (!input.activePlan || !hasPlanReference) {
    if (!input.activePlan && hasPlanReference) {
      throw new Error("当前运行没有已批准的权威计划，禁止提交悬空计划引用")
    }
    return input.submittedNodes.map((node, index) => {
      if (typeof node.id !== "string" || !node.id.trim()
        || typeof node.description !== "string" || !node.description.trim()
        || typeof node.subagent !== "string" || !node.subagent.trim()) {
        throw new Error(`delegate_dag.nodes[${index}] 缺少 id、description 或 subagent`)
      }
      return {
        ...node,
        id: node.id.trim(),
        description: node.description.trim(),
        subagent: node.subagent.trim(),
        acceptance: uniqueStrings(node.acceptance),
      }
    })
  }
  if (input.planId !== input.activePlan.identity.planId
    || input.planVersion !== input.activePlan.identity.version) {
    throw new Error(
      `delegate_dag 必须引用当前权威计划 ${input.activePlan.identity.planId}@${input.activePlan.identity.version}`,
    )
  }
  if (input.submittedNodes.length !== input.activePlan.nodes.length) {
    throw new Error("delegate_dag 必须一次引用权威计划中的全部节点，禁止遗漏或增加节点")
  }
  const references = input.submittedNodes.map((node) => node.plan_node_id)
  if (references.some((nodeId) => typeof nodeId !== "string")
    || new Set(references).size !== references.length) {
    throw new Error("delegate_dag 的每个计划节点引用必须存在且唯一")
  }
  const expectedIds = new Set(input.activePlan.nodes.map((node) => node.nodeId))
  if (references.some((nodeId) => !expectedIds.has(nodeId!))) {
    throw new Error("delegate_dag 包含不属于当前权威计划的节点")
  }
  return input.activePlan.nodes.map((node) => {
    const supplied = input.submittedNodes.find((item) => item.plan_node_id === node.nodeId)!
    const resolved = resolveExecutablePlanNode(input.activePlan!, {
      planId: input.planId!,
      version: input.planVersion!,
      nodeId: node.nodeId,
    })
    assertPlanNodeInvocationMatches({
      node: resolved,
      id: supplied.id,
      dependsOn: supplied.depends_on,
      subagent: supplied.subagent,
      requiredEffects: supplied.required_effects,
      reads: supplied.resource_claims?.reads,
      writes: supplied.resource_claims?.writes,
      acceptance: supplied.acceptance,
      expectedOutputs: supplied.expected_outputs,
    })
    const contract = resolved.taskContract
    if (supplied.description !== undefined && supplied.description.trim() !== contract.objective) {
      throw new Error(`计划节点 ${node.nodeId} 的目标不可改写`)
    }
    if (supplied.prompt !== undefined && supplied.prompt.trim() !== contract.instructions) {
      throw new Error(`计划节点 ${node.nodeId} 的执行指令不可改写`)
    }
    if (supplied.acceptance_criteria !== undefined) {
      throw new Error(`计划节点 ${node.nodeId} 的验收验证器由运行时派生，禁止重复提交`)
    }
    return {
      id: node.nodeId,
      plan_node_id: node.nodeId,
      description: contract.objective,
      subagent: resolved.assigneeAgentId,
      prompt: contract.instructions,
      depends_on: [...resolved.dependsOn],
      resource_claims: {
        reads: [...contract.resources.reads],
        writes: [...contract.resources.writes],
      },
      constraints: [...contract.constraints],
      acceptance: [...contract.acceptance],
      acceptance_criteria: contract.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        verifier: criterion.verifier,
        targetPatterns: [...criterion.targetPatterns],
      })),
      expected_outputs: [...contract.expectedOutputs],
      required_effects: [...contract.requiredEffects],
    }
  })
}
