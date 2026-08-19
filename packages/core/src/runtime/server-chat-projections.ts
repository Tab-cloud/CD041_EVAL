import type { ExecutionSnapshot } from "./agent-loop-control.ts"
import type { ConversationTurnKind } from "./conversation-turn-intent.ts"
export {
  projectPublicApproval as publicApproval,
  projectPublicQuestion as publicQuestion,
  projectPublicTaskStatus as taskView,
} from "./public-run-event.ts"
export type {
  PublicApprovalView,
  PublicQuestionView,
  PublicTaskView,
} from "./public-run-event.ts"

export function buildMainAgentCoordinationContext(input: {
  executionAgentId: string
  executionAgentName: string
  source: string
  requiredEffects: string[]
  goalType: string
  turnKind?: ConversationTurnKind
  command?: string
}): string {
  const mandatory = input.command
    ? "这是内部协议角色，必须由主 Agent 通过 task 委派执行并验收。"
    : "把该角色视为首选执行者；简单任务可由主 Agent 直接完成，复杂或专业任务应通过 task 委派。"
  const executionPreference = input.goalType === "build"
    ? "这是构建目标：Eval 内置编译仅支持 Espressif ESP 系列的原生 ESP-IDF 工程。直接调用 compile；若其报告非 ESP 项目不受支持，不得用 bash 绕过产品边界。非 ESP 项目仍可继续源码编写与设计，并明确告知用户需在厂商 IDE 或自备工具链中手动编译。读取配置不能作为编译完成证据。"
    : ""
  const interactionBoundary = input.turnKind === "domain-query" || input.turnKind === "conversation"
    ? "这是信息咨询回合：直接回答用户的问题。可以读取或检索必要证据，但不得创建实施清单、修改文件、运行编译/测试、操作硬件或委派子 Agent。"
    : ""
  return `## 主 Agent 编排上下文
当前根运行的 owner 始终是主 Agent。推荐专业执行角色：${input.executionAgentName}（${input.executionAgentId}）。
推荐来源：${input.source}；目标所需工具效果：${input.requiredEffects.join(", ") || "无强制工具效果"}。
${mandatory}
${executionPreference}
${interactionBoundary}
专业角色及其内部消息不得直接面向用户；主 Agent 必须检查产物、证据和未解决项后再决定是否完成。`
}

export function buildExecutionStatusContext(
  snapshot: ExecutionSnapshot,
  task: { message: string; status: string; error?: string; result?: string } | null,
): string {
  const stateLabels: Record<ExecutionSnapshot["state"], string> = {
    running: "执行中",
    "waiting-approval": "等待用户批准",
    blocked: "等待外部条件",
    finalizing: "正在收敛验收",
    completed: "已完成",
    failed: "执行失败",
    cancelled: "已取消",
    interrupted: "已中断，可续接",
  }
  const todos = snapshot.todos.length > 0
    ? snapshot.todos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")
    : "- 当前运行没有任务清单"
  const reason = snapshot.stopReason || task?.error || ""

  return `## 当前会话任务状态（运行时权威快照）
用户正在查询状态，不是在发起新的执行动作。直接依据以下快照给出简洁、明确的状态答复；不要调用工具，不要回复“正在读取/正在检查/马上开始”等过程性占位文本。
目标：${task?.message || snapshot.runtimeObjectiveContent || "当前会话任务"}
状态：${stateLabels[snapshot.state]}${task?.status ? `（任务记录：${task.status}）` : ""}
${reason ? `原因：${reason}` : ""}
任务清单：
${todos}
${snapshot.followups?.length ? `用户后续操作：\n${snapshot.followups.map((item) => `- ${item.content}`).join("\n")}` : ""}
答复必须说明：是否仍在执行、已完成什么、剩余或阻塞什么。`
}

/**
 * Render the authoritative status directly from the execution ledger.
 * A model may classify the user's intent, but it cannot invent or rewrite
 * completion state, evidence, artifact sizes or remaining work.
 */
export function renderExecutionStatus(
  snapshot: ExecutionSnapshot | undefined,
  task: { message: string; status: string; error?: string; result?: string } | null,
): string {
  if (!snapshot) return "当前会话没有可追踪的执行任务。"
  const labels: Record<ExecutionSnapshot["state"], string> = {
    running: "正在执行",
    "waiting-approval": "等待你的批准",
    blocked: "等待外部条件",
    finalizing: "正在进行最终验收",
    completed: "已完成",
    failed: "执行失败，尚未完成",
    cancelled: "已取消",
    interrupted: "已中断，可以续接",
  }
  const completed = snapshot.todos.filter((todo) => todo.status === "completed")
  const outstanding = snapshot.todos.filter((todo) => todo.status !== "completed")
  const lines = [
    `当前状态：${labels[snapshot.state]}。`,
    `已取得 ${snapshot.toolRounds} 轮工具执行记录。`,
  ]
  if (snapshot.stopReason || task?.error) lines.push(`原因：${snapshot.stopReason || task?.error}`)
  if (completed.length) {
    lines.push("已完成：", ...completed.map((todo) => `- ${todo.content}`))
  }
  if (outstanding.length) {
    lines.push("尚未完成：", ...outstanding.map((todo) => `- [${todo.status}] ${todo.content}`))
  }
  if (snapshot.followups?.length) {
    lines.push("需要用户后续处理：", ...snapshot.followups.map((followup) => `- ${followup.content}`))
  }
  return lines.join("\n")
}

export function publicExecutionState(snapshot: ExecutionSnapshot) {
  return {
    state: snapshot.state,
    todos: snapshot.todos,
    followups: snapshot.followups ?? [],
    stopReason: snapshot.stopReason,
    updatedAt: snapshot.updatedAt,
  }
}

export function settleExecutionSnapshot(
  snapshot: ExecutionSnapshot,
  state: "blocked" | "failed" | "cancelled" | "interrupted",
  reason: string,
): ExecutionSnapshot {
  return {
    ...snapshot,
    state,
    todos: snapshot.todos.map((todo) => todo.status === "in_progress"
      ? { ...todo, status: state === "blocked" ? "blocked" as const : "paused" as const }
      : todo),
    stopReason: reason,
    updatedAt: Date.now(),
  }
}

/** Publish state transitions, not repeated observations of the same state. */
export function createTaskStatusPublisher<T extends {
  id: string
  status: string
  startedAt?: number
  completedAt?: number
  message?: string
  problem?: { code?: string; diagnosticId?: string }
}>(publish: (task: T) => void): (task: T) => boolean {
  let lastSignature = ""
  return (task) => {
    const signature = JSON.stringify([
      task.id, task.status, task.startedAt, task.completedAt, task.message,
      task.problem?.code, task.problem?.diagnosticId,
    ])
    if (signature === lastSignature) return false
    lastSignature = signature
    publish(task)
    return true
  }
}

const INTERNAL_ORCHESTRATION_TOOLS = new Set([
  "task",
  "delegate_dag",
  "todowrite",
])

export function isInternalOrchestrationTool(name: unknown): boolean {
  return typeof name === "string" && INTERNAL_ORCHESTRATION_TOOLS.has(name)
}

/**
 * Conversation messages are a public projection, not the orchestration audit
 * log. Apply the same privacy boundary to durable history as to live SSE so
 * reopening a session cannot reveal child scheduling details that were hidden
 * during the original run.
 */
export function publicToolRecords<T extends { name?: unknown }>(
  records: readonly T[],
): T[] {
  return records.filter((record) => !isInternalOrchestrationTool(record.name))
}
