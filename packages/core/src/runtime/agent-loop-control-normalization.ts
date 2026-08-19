import type { ObjectiveEvidenceKind } from "./objective-compiler.ts"
import type {
  ExecutionFollowup,
  ExecutionTodo,
  ExecutionTodoStatus,
} from "./agent-loop-control.ts"

const OBJECTIVE_EVIDENCE_KINDS = new Set<ObjectiveEvidenceKind>([
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
])

export function normalizeExecutionTodos(value: unknown): ExecutionTodo[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.todos)
      ? value.todos
      : []
  return source.slice(0, 100).flatMap((item): ExecutionTodo[] => {
    if (!isRecord(item) || typeof item.content !== "string") return []
    const content = item.content.trim().slice(0, 2_000)
    if (!content) return []
    const status = isTodoStatus(item.status) ? item.status : "pending"
    const priority = item.priority === "high" || item.priority === "low" ? item.priority : "medium"
    const acceptance = typeof item.acceptance === "string"
      ? item.acceptance.trim().slice(0, 2_000)
      : undefined
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.slice(0, 2_000)).slice(0, 20)
      : undefined
    const assignee = typeof item.assignee === "string"
      ? item.assignee.trim().slice(0, 128)
      : undefined
    const blockedBy = typeof item.blockedBy === "string"
      && OBJECTIVE_EVIDENCE_KINDS.has(item.blockedBy as ObjectiveEvidenceKind)
      ? item.blockedBy as ObjectiveEvidenceKind
      : undefined
    return [{
      content,
      status,
      priority,
      acceptance: acceptance || undefined,
      evidence,
      ...(assignee ? { assignee } : {}),
      ...(blockedBy ? { blockedBy } : {}),
    }]
  })
}

export function normalizeExecutionFollowups(value: unknown): ExecutionFollowup[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 50).flatMap((item): ExecutionFollowup[] => {
    if (!isRecord(item) || typeof item.content !== "string") return []
    const content = item.content.trim().slice(0, 2_000)
    if (!content) return []
    return [{
      content,
      owner: "user",
      category: item.category === "hardware-validation"
        ? "hardware-validation"
        : "external-action",
      reason: typeof item.reason === "string"
        ? item.reason.trim().slice(0, 2_000) || undefined
        : undefined,
    }]
  })
}

function isTodoStatus(value: unknown): value is ExecutionTodoStatus {
  return value === "pending"
    || value === "in_progress"
    || value === "paused"
    || value === "blocked"
    || value === "completed"
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
