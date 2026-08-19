import { TaskRunRepo } from "../store/task-run"
import type { UserQuestionRequest } from "./user-question"

/**
 * Public interaction is owned by the root main Agent. Delegated workers may
 * request information, but their role names, run ids and orchestration
 * protocol must never become the user-facing prompt.
 */
export function brokerPublicQuestion(question: UserQuestionRequest): UserQuestionRequest {
  const source = TaskRunRepo.get(question.runId)
  if (!source?.parentRunId) return question
  return {
    ...question,
    runId: rootRunId(source.id),
    question: `继续当前任务需要你的选择：${sanitizeDelegatedPrompt(question.question)}`,
  }
}

function rootRunId(runId: string): string {
  let current = TaskRunRepo.get(runId)
  const visited = new Set<string>()
  while (current?.parentRunId && !visited.has(current.id)) {
    visited.add(current.id)
    current = TaskRunRepo.get(current.parentRunId)
  }
  return current?.id ?? runId
}

function sanitizeDelegatedPrompt(value: string): string {
  return value
    .replace(/\b(?:sub[- ]?agent|child agent|agentId|runId|parentRunId)\b/gi, "执行环节")
    .replace(/(?:子|原子|专业)\s*Agent/gi, "执行环节")
    .replace(/\btask-[A-Za-z0-9-]{4,}\b/g, "当前任务")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_900)
}
