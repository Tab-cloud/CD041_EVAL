import { defineTool } from "../define"
import {
  normalizeExecutionFollowups,
  normalizeExecutionTodos,
} from "../../runtime/agent-loop-control"

export const todowriteTool = defineTool({
  name: "todowrite",
  description: "更新 Agent 可执行任务清单和不阻塞完成的用户后续操作。发送完整的 todos；人工烧录、接线和实机观察必须放入 followups。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "任务描述" },
            status: { type: "string", description: "pending / in_progress / paused / blocked / completed。blocked 仅用于用户原始验收条件确实依赖外部证据的任务。" },
            priority: { type: "string", description: "high / medium / low" },
            acceptance: { type: "string", description: "可验证的验收条件" },
            assignee: {
              type: "string",
              description: "主 Agent 语义规划后发布的已注册执行角色 ID；省略时由主 Agent 自己负责。运行时只校验 ID，不根据任务文字猜测角色。",
            },
            blockedBy: {
              type: "string",
              description: "blocked 时必填：当前被阻断的运行时证据类型，如 hardware-observation。若不属于用户原始验收条件，应改放 followups。",
            },
          },
          required: ["content", "status", "priority", "acceptance"],
        },
        description: "完整的任务列表",
      },
      followups: {
        type: "array",
        description: "不阻塞 Agent 交付、需要用户后续手动执行的事项，例如 J-Link 烧录、接线、观察示波器或串口。",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "用户后续操作" },
            category: { type: "string", description: "hardware-validation / external-action" },
            reason: { type: "string", description: "为何需要用户手动完成" },
          },
          required: ["content", "category"],
        },
      },
    },
    required: ["todos"],
  },
  async execute({ todos, followups }: { todos: unknown[]; followups?: unknown[] }) {
    const normalized = normalizeExecutionTodos(todos).map(({ evidence: _untrustedEvidence, ...todo }) => ({
      ...todo,
      // Pausing is a runtime transition, never a model-authored terminal
      // decision. A blocked todo without a typed evidence dependency is also
      // kept runnable for the blocker arbiter to evaluate in the controller.
      status: todo.status === "paused"
        ? "pending" as const
        : todo.status === "blocked" && !todo.blockedBy
          ? "pending" as const
          : todo.status,
    }))
    const normalizedFollowups = normalizeExecutionFollowups(followups)
    const counts = { pending: 0, in_progress: 0, paused: 0, blocked: 0, completed: 0 }
    for (const t of normalized) {
      const k = t.status as keyof typeof counts
      counts[k] = (counts[k] || 0) + 1
    }
    const summary = `完成 ${counts.completed} / 进行中 ${counts.in_progress} / 暂停 ${counts.paused} / 等待条件 ${counts.blocked} / 待办 ${counts.pending}`
    const followupSummary = normalizedFollowups.length > 0 ? ` / 用户后续 ${normalizedFollowups.length}` : ""
    return { success: true, data: { todos: normalized, followups: normalizedFollowups, summary: summary + followupSummary } }
  },
  contract: { effects: ["user-interaction"], idempotency: "idempotent", cancellation: "unsupported", progress: { role: "control" } }, permission: "todowrite",
})
