import { MAIN_AGENT_ID } from "../agent/definitions/main-agent.ts"
import { SessionCommandRepo } from "../store/session-command.ts"
import { SessionRepo } from "../store/repository.ts"
import type { ScheduledTask } from "./task-scheduler.ts"
import { taskScheduler } from "./task-scheduler.ts"
import { logOrchestrationEvent } from "./orchestration-log.ts"
import type { ExecutionScope } from "./tool-policy.ts"

export type RootAdmissionStage =
  | "admission"
  | "conversation-intent"
  | "semantic-routing"
  | "execution-preparation"

export class RootAdmissionPhaseError extends Error {
  constructor(
    readonly stage: RootAdmissionStage,
    readonly kind: string,
    readonly publicMessage: string,
    message: string,
    readonly httpStatus = 503,
    readonly rootRunId?: string,
  ) {
    super(message)
    this.name = "RootAdmissionPhaseError"
  }
}

export interface AdmittedChatRoot {
  task: ScheduledTask
  abortController: AbortController
}

/**
 * Establish the durable root owner before any model-owned interpretation.
 *
 * The root identity is stable and deliberately independent from the specialist
 * selected later by semantic routing. Binding the command here makes the
 * session command and task-run one lifecycle aggregate for every subsequent
 * preparation phase.
 */
export function admitChatRoot(input: {
  requestId: string
  commandOwner: string
  sessionId: string
  message: string
  workingDir: string
  scope: ExecutionScope
  effort: "on" | "off"
  modelId?: string
  retryOf?: string
}): AdmittedChatRoot {
  const existingSession = SessionRepo.get(input.sessionId)
  if (!existingSession) {
    SessionRepo.create({
      id: input.sessionId,
      title: input.message.slice(0, 30),
      agent_id: MAIN_AGENT_ID,
      project_path: input.workingDir !== process.cwd() ? input.workingDir : null,
      composer_model_id: input.modelId ?? null,
      composer_effort: input.effort,
      composer_scope: input.scope,
    })
  } else if (existingSession.agent_id !== MAIN_AGENT_ID) {
    SessionRepo.update(input.sessionId, { agent_id: MAIN_AGENT_ID })
  }

  const abortController = new AbortController()
  const abortRun = () => {
    if (!abortController.signal.aborted) abortController.abort()
  }
  const task = taskScheduler.enqueue({
    requestId: input.requestId,
    sessionId: input.sessionId,
    agentId: MAIN_AGENT_ID,
    priority: 8,
    type: "chat",
    message: input.message,
    workingDir: input.workingDir,
    scope: input.scope,
    effort: input.effort,
    modelId: input.modelId,
    retryOf: input.retryOf,
    onProgress: () => {},
    onComplete: () => {},
    onError: () => {},
    onCancel: abortRun,
  })

  if (!SessionCommandRepo.bindTask(input.requestId, input.commandOwner, task.id)) {
    taskScheduler.cancel(task.id)
    if (task.status === "cancelling") {
      taskScheduler.confirmWorkerExit(task.id, "根任务绑定失败，执行体未启动")
    }
    SessionCommandRepo.finishOwned(
      input.requestId,
      input.commandOwner,
      "failed",
      "会话命令未能绑定根任务",
    )
    throw new RootAdmissionPhaseError(
      "admission",
      "root-command-bind-failed",
      "会话命令未能建立根任务",
      "会话命令未能绑定根任务",
      409,
      task.id,
    )
  }

  logOrchestrationEvent({
    sessionId: input.sessionId,
    runId: task.id,
    agentId: MAIN_AGENT_ID,
    eventType: "root.admitted",
    message: "主 Agent 根任务已取得会话命令所有权",
    data: {
      requestId: input.requestId,
      commandBound: true,
      phase: "admission",
    },
  })
  return { task, abortController }
}

/**
 * Close a preparation failure through the root task, never around it.
 * TaskRunRepo projects this terminal atomically back to the bound command.
 */
export function failAdmittedChatRoot(
  root: AdmittedChatRoot,
  error: RootAdmissionPhaseError,
): void {
  logOrchestrationEvent({
    sessionId: root.task.sessionId,
    runId: root.task.id,
    agentId: root.task.agentId,
    eventType: "root.preexecution-failed",
    level: "error",
    message: "主 Agent 根任务在执行准备阶段失败",
    data: {
      stage: error.stage,
      kind: error.kind,
      reason: error.message,
    },
  })
  if (root.task.status === "running") {
    taskScheduler.failTask(root.task.id, error.message)
    return
  }
  if (root.task.status === "queued") {
    taskScheduler.cancel(root.task.id)
    return
  }
  if (root.task.status === "cancelling") {
    taskScheduler.confirmWorkerExit(root.task.id, error.message)
  }
}

export function asRootAdmissionPhaseError(
  error: unknown,
  stage: RootAdmissionStage,
  publicMessage: string,
  fallbackKind: string,
): RootAdmissionPhaseError {
  if (error instanceof RootAdmissionPhaseError) return error
  const reason = error instanceof Error ? error.message : String(error)
  const kind = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? fallbackKind)
    : fallbackKind
  return new RootAdmissionPhaseError(stage, kind, publicMessage, reason)
}
