import { defineTool } from "../define"
import {
  normalizePlanContract,
  PLAN_CONTRACT_JSON_SCHEMA,
  renderPlanContractMarkdown,
} from "../../runtime/plan-contract.ts"
import { unsupportedTaskEffects } from "../../runtime/task-capability.ts"
import { invalidToolInputResult } from "../outcome.ts"

export const planTool = defineTool({
  name: "plan",
  description: `提交可执行 PlanContract 供用户审批。

contract 是唯一权威计划，必须包含稳定 planId、类型化 DAG 节点、依赖、
递增 version、节点 goalType、执行 Agent、工具效果、资源边界、验收证据、
预期输出和阻塞类别。验收只提交 anyOf 证据类型，禁止提交 verifier；
运行时使用统一证据兼容矩阵派生 verifier。
禁止提交 Markdown 步骤、空壳计划或缺少验收条件的节点。
运行时会从 contract 自动生成用户可读 Markdown。`,

  permission: "plan",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      contract: PLAN_CONTRACT_JSON_SCHEMA,
    },
    required: ["contract"],
  },

  contract: { effects: ["user-interaction"], idempotency: "idempotent", cancellation: "unsupported", progress: { role: "control" } },

  async execute(params, ctx) {
    try {
      const contract = normalizePlanContract(params.contract, ctx.workingDir)
      if (!ctx.agentRegistry || !ctx.toolRegistry) {
        throw new Error("PlanContract 验证需要 AgentRegistry 与 ToolRegistry")
      }
      for (const node of contract.nodes) {
        const assignee = ctx.agentRegistry.get(node.assigneeAgentId)
        if (!assignee || assignee.mode === "primary") {
          throw new Error(`节点 ${node.nodeId} 必须分配给已注册的原子子 Agent`)
        }
        const unsupported = unsupportedTaskEffects({
          agent: assignee,
          tools: ctx.toolRegistry,
          requiredEffects: node.requiredEffects,
          scope: ctx.scope ?? "auto-edit",
          policy: ctx.toolPolicy,
          workingDir: ctx.workingDir,
        })
        if (unsupported.length > 0) {
          throw new Error(
            `节点 ${node.nodeId} 的执行角色 ${assignee.id} 缺少工具效果：${unsupported.join(", ")}`,
          )
        }
      }
      return {
        success: true,
        data: {
          title: contract.title,
          content: renderPlanContractMarkdown(contract),
          contract,
        },
      }
    } catch (error) {
      return invalidToolInputResult(
        "plan",
        error instanceof Error ? error : new Error("PlanContract 无效"),
      )
    }
  },
})
