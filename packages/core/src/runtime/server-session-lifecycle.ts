import { taskScheduler } from "./task-scheduler"
import type { WorkflowEngine } from "./workflow-engine"
import { WorkflowRepo, WorkflowScheduleRepo } from "../store/workflow"
import { SessionCommandRepo } from "../store/session-command.ts"
import { userQuestionManager } from "./user-question"
import { toolApprovalManager } from "./tool-approval"
import { getDb } from "../store/database.ts"
import {
  SessionLifecycleManager,
  type SessionLifecycleResult,
} from "./session-lifecycle.ts"
import { json } from "./server-response"

export function createServerSessionLifecycleManager(
  getWorkflowEngine: () => WorkflowEngine | null,
): SessionLifecycleManager {
  return new SessionLifecycleManager({
    tasks: {
      list: (sessionId) => taskScheduler.getSessionTasks(sessionId),
      cancel: (taskId) => taskScheduler.cancel(taskId),
    },
    workflows: {
      list: (sessionId) => WorkflowRepo.list(sessionId, 100),
      cancel: (workflowId) => {
        const workflowEngine = getWorkflowEngine()
        if (!workflowEngine) throw new Error("工作流引擎未初始化")
        return workflowEngine.cancel(workflowId)
      },
      disableSchedules: (sessionId) => {
        for (const schedule of WorkflowScheduleRepo.list(sessionId)) {
          if (schedule.enabled) WorkflowScheduleRepo.update(schedule.id, { enabled: false })
        }
      },
    },
    commands: {
      listPending: (sessionId) => SessionCommandRepo.listPending(sessionId),
      cancel: (requestId, reason) => SessionCommandRepo.finish(requestId, "cancelled", reason),
    },
    questions: {
      list: (sessionId) => userQuestionManager.list(sessionId),
      cancel: (id) => userQuestionManager.cancel(id),
    },
    approvals: {
      list: (sessionId) => toolApprovalManager.list(sessionId),
      cancel: (id) => toolApprovalManager.respond(id, false),
    },
  })
}

export async function sessionMutationTarget(
  req: Request,
  url: URL,
): Promise<string | null> {
  if (req.method !== "POST" && req.method !== "PUT") return null
  const path = url.pathname
  if (![
    "/api/chat",
    "/api/session-commands",
    "/api/tasks/guidance",
    "/api/workflows",
    "/api/workflows/action",
    "/api/workflow-schedules",
    "/api/workflow-schedules/run",
  ].includes(path)) return null

  const body = await req.clone().json().catch(() => ({})) as Record<string, unknown>
  if (typeof body.sessionId === "string") return body.sessionId
  if (typeof body.workflowId === "string") {
    return WorkflowRepo.get(body.workflowId)?.sessionId ?? null
  }
  if (typeof body.id === "string" && path.startsWith("/api/workflow-schedules")) {
    return WorkflowScheduleRepo.get(body.id)?.sessionId ?? null
  }
  return null
}

export function lifecycleResponse<T>(
  result: SessionLifecycleResult<T>,
  cors: Record<string, string>,
): Response {
  if (result.status === "completed") return json(result.value, cors)
  if (result.status === "pending") {
    return json({
      success: false,
      terminating: true,
      lifecycle: result.lifecycle,
    }, { ...cors, status: 202 })
  }
  return json({
    error: result.lifecycle.error ?? "会话终止未完成",
    terminating: true,
    lifecycle: result.lifecycle,
  }, { ...cors, status: result.lifecycle.phase === "cleanup-failed" ? 500 : 503 })
}

/**
 * The durable half of session cleanup is one aggregate transaction. It is
 * intentionally invoked only after SessionLifecycleManager proves there are
 * no live Workers, workflow nodes, queued commands or user interactions.
 */
export function purgeSessionAggregate(sessionId: string, deleteSession: boolean): void {
  const db = getDb()
  db.transaction(() => {
    db.run(
      "DELETE FROM workspace_change_sets WHERE run_id IN (SELECT run_id FROM run_contracts WHERE session_id = ?)",
      [sessionId],
    )
    db.run(
      "DELETE FROM workflow_webhook_deliveries WHERE workflow_id IN (SELECT id FROM workflow_runs WHERE session_id = ?)",
      [sessionId],
    )
    for (const table of [
      "workflow_schedules",
      "workflow_runs",
      "conversation_objectives",
      "session_artifacts",
      "main_agent_interactions",
      "run_guidance",
      "session_commands",
      "run_graphs",
      "run_contracts",
      "agent_orchestration_logs",
      "build_log_lines",
      "run_events",
      "tool_approvals",
      "execution_runs",
      "llm_call_logs",
      "model_attempts",
      "tool_executions",
      "task_runs",
      "checkpoints",
      "messages",
    ]) {
      db.run(`DELETE FROM ${table} WHERE session_id = ?`, [sessionId])
    }
    if (deleteSession) {
      db.run("DELETE FROM session_artifact_state WHERE session_id = ?", [sessionId])
      db.run("DELETE FROM sessions WHERE id = ?", [sessionId])
      return
    }
    db.run(
      `INSERT INTO session_artifact_state (session_id, revision)
       VALUES (?, 1)
       ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1`,
      [sessionId],
    )
    db.run(
      `UPDATE sessions
       SET compact_summary = NULL, compact_at = NULL, schematics = '[]', documents = '[]', updated_at = ?
       WHERE id = ?`,
      [Date.now(), sessionId],
    )
  })()
}
