import type { ExecutionTodo } from "./agent-loop-control.ts"

export interface DispatchAssignment {
  todos: ExecutionTodo[]
  instruction?: string
}

/**
 * Assigns domain-specific work without exposing role selection to user output.
 * Execution still goes through the task tool so normal permission, timeout and
 * activity propagation rules remain authoritative.
 */
export function assignExecutionTodos(
  todos: ExecutionTodo[],
  currentAgentId: string,
  availableAgentIds: Iterable<string>,
  canDelegate: boolean,
): DispatchAssignment {
  const available = new Set(availableAgentIds)
  const assigned = todos.map((todo) => ({
    ...todo,
    assignee: todo.assignee && available.has(todo.assignee)
      ? todo.assignee
      : currentAgentId,
  }))
  if (!canDelegate) return { todos: assigned }
  const next = assigned.find((todo) => (todo.status === "in_progress" || todo.status === "pending") && todo.assignee && todo.assignee !== currentAgentId)
  if (!next) return { todos: assigned }
  return {
    todos: assigned,
    instruction: [
      "[运行时任务分派]",
      `当前任务：${next.content}`,
      `责任角色：${next.assignee}`,
      "请立即通过 task 工具委派该任务，等待真实结果并把结果作为验收证据；不要向用户说明内部角色选择或调度过程。",
    ].join("\n"),
  }
}
