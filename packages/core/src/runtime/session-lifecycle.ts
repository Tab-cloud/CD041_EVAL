/**
 * Session lifecycle coordinator.
 *
 * Deleting or clearing a session is an aggregate transition, not a collection
 * of unrelated DELETE statements. The coordinator fences new work first,
 * requests cancellation for every execution surface, waits for Worker exit
 * acknowledgement, and only then invokes the durable cleanup transaction.
 */

export type SessionLifecycleMode = "delete" | "clear"
export type SessionLifecyclePhase =
  | "terminating"
  | "waiting-exit"
  | "cleanup"
  | "cleanup-failed"

type TaskState = {
  id: string
  status: string
}

type WorkflowState = {
  id: string
  status: string
}

type PendingCommand = {
  requestId: string
}

type PendingInteraction = {
  id: string
}

export interface SessionLifecycleDependencies {
  tasks: {
    list(sessionId: string): TaskState[]
    cancel(taskId: string): boolean
  }
  workflows: {
    list(sessionId: string): WorkflowState[]
    cancel(workflowId: string): unknown
    disableSchedules(sessionId: string): void
  }
  commands: {
    listPending(sessionId: string): PendingCommand[]
    cancel(requestId: string, reason: string): unknown
  }
  questions: {
    list(sessionId: string): PendingInteraction[]
    cancel(id: string): unknown
  }
  approvals: {
    list(sessionId: string): PendingInteraction[]
    cancel(id: string): unknown
  }
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export interface SessionLifecycleSnapshot {
  sessionId: string
  mode: SessionLifecycleMode
  phase: SessionLifecyclePhase
  startedAt: number
  updatedAt: number
  pending: {
    taskIds: string[]
    workflowIds: string[]
    commandIds: string[]
    questionIds: string[]
    approvalIds: string[]
  }
  error?: string
}

export type SessionLifecycleResult<T> =
  | { status: "completed"; value: T }
  | { status: "pending"; lifecycle: SessionLifecycleSnapshot }
  | { status: "failed"; lifecycle: SessionLifecycleSnapshot }

interface MutableLifecycleState extends SessionLifecycleSnapshot {
  inFlight?: Promise<SessionLifecycleResult<unknown>>
}

const TERMINAL_TASK_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
])

const TERMINAL_WORKFLOW_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
])

export class SessionLifecycleManager {
  private readonly states = new Map<string, MutableLifecycleState>()
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(private readonly dependencies: SessionLifecycleDependencies) {
    this.now = dependencies.now ?? Date.now
    this.sleep = dependencies.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  isTerminating(sessionId: string): boolean {
    return this.states.has(sessionId)
  }

  getState(sessionId: string): SessionLifecycleSnapshot | null {
    const state = this.states.get(sessionId)
    return state ? snapshot(state) : null
  }

  async terminate<T>(input: {
    sessionId: string
    mode: SessionLifecycleMode
    cleanup: () => T | Promise<T>
    waitTimeoutMs?: number
    pollIntervalMs?: number
  }): Promise<SessionLifecycleResult<T>> {
    const existing = this.states.get(input.sessionId)
    if (existing?.mode !== undefined && existing.mode !== input.mode) {
      existing.phase = "cleanup-failed"
      existing.updatedAt = this.now()
      existing.error = `会话正在执行 ${existing.mode}，不能切换为 ${input.mode}`
      return { status: "failed", lifecycle: snapshot(existing) }
    }
    if (existing?.inFlight) {
      return existing.inFlight as Promise<SessionLifecycleResult<T>>
    }

    const state = existing ?? this.createState(input.sessionId, input.mode)
    state.phase = "terminating"
    state.updatedAt = this.now()
    state.error = undefined
    this.states.set(input.sessionId, state)

    const operation = this.runTermination(state, input)
    state.inFlight = operation as Promise<SessionLifecycleResult<unknown>>
    try {
      return await operation
    } finally {
      if (state.inFlight === operation) state.inFlight = undefined
    }
  }

  private async runTermination<T>(
    state: MutableLifecycleState,
    input: {
      sessionId: string
      mode: SessionLifecycleMode
      cleanup: () => T | Promise<T>
      waitTimeoutMs?: number
      pollIntervalMs?: number
    },
  ): Promise<SessionLifecycleResult<T>> {
    const waitTimeoutMs = Math.max(0, input.waitTimeoutMs ?? 5_000)
    const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? 25)
    const deadline = this.now() + waitTimeoutMs

    while (true) {
      const cancellationErrors = this.requestCancellation(input.sessionId)
      const pending = this.pendingWork(input.sessionId)
      state.pending = pending
      state.updatedAt = this.now()
      if (cancellationErrors.length > 0) {
        state.phase = "waiting-exit"
        state.error = cancellationErrors.join("; ").slice(0, 4_000)
        return { status: "failed", lifecycle: snapshot(state) }
      }
      if (pendingCount(pending) === 0) break
      if (this.now() >= deadline) {
        state.phase = "waiting-exit"
        return { status: "pending", lifecycle: snapshot(state) }
      }
      await this.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - this.now())))
    }

    state.phase = "cleanup"
    state.updatedAt = this.now()
    try {
      const value = await input.cleanup()
      this.states.delete(input.sessionId)
      return { status: "completed", value }
    } catch (error) {
      state.phase = "cleanup-failed"
      state.updatedAt = this.now()
      state.error = messageOf(error)
      return { status: "failed", lifecycle: snapshot(state) }
    }
  }

  private requestCancellation(sessionId: string): string[] {
    const errors: string[] = []
    const attempt = (label: string, action: () => unknown) => {
      try {
        action()
      } catch (error) {
        errors.push(`${label}: ${messageOf(error)}`)
      }
    }

    attempt("禁用工作流计划", () => this.dependencies.workflows.disableSchedules(sessionId))
    for (const command of this.dependencies.commands.listPending(sessionId)) {
      attempt(`取消命令 ${command.requestId}`, () =>
        this.dependencies.commands.cancel(command.requestId, "会话正在终止"))
    }
    for (const question of this.dependencies.questions.list(sessionId)) {
      attempt(`取消用户问题 ${question.id}`, () => this.dependencies.questions.cancel(question.id))
    }
    for (const approval of this.dependencies.approvals.list(sessionId)) {
      attempt(`取消权限申请 ${approval.id}`, () => this.dependencies.approvals.cancel(approval.id))
    }
    for (const workflow of this.dependencies.workflows.list(sessionId)) {
      if (!TERMINAL_WORKFLOW_STATES.has(workflow.status)) {
        attempt(`取消工作流 ${workflow.id}`, () => this.dependencies.workflows.cancel(workflow.id))
      }
    }

    // Cancel roots first so the scheduler recursively closes descendants.
    // A second pass catches detached or recovering tasks without assuming the
    // hierarchy is complete in volatile memory.
    const activeTasks = this.dependencies.tasks.list(sessionId)
      .filter((task) => !TERMINAL_TASK_STATES.has(task.status))
    for (const task of activeTasks) {
      attempt(`取消任务 ${task.id}`, () => this.dependencies.tasks.cancel(task.id))
    }
    return errors
  }

  private pendingWork(sessionId: string): SessionLifecycleSnapshot["pending"] {
    return {
      taskIds: this.dependencies.tasks.list(sessionId)
        .filter((task) => !TERMINAL_TASK_STATES.has(task.status))
        .map((task) => task.id),
      workflowIds: this.dependencies.workflows.list(sessionId)
        .filter((workflow) => !TERMINAL_WORKFLOW_STATES.has(workflow.status))
        .map((workflow) => workflow.id),
      commandIds: this.dependencies.commands.listPending(sessionId).map((command) => command.requestId),
      questionIds: this.dependencies.questions.list(sessionId).map((request) => request.id),
      approvalIds: this.dependencies.approvals.list(sessionId).map((request) => request.id),
    }
  }

  private createState(sessionId: string, mode: SessionLifecycleMode): MutableLifecycleState {
    const now = this.now()
    return {
      sessionId,
      mode,
      phase: "terminating",
      startedAt: now,
      updatedAt: now,
      pending: emptyPending(),
    }
  }
}

function emptyPending(): SessionLifecycleSnapshot["pending"] {
  return {
    taskIds: [],
    workflowIds: [],
    commandIds: [],
    questionIds: [],
    approvalIds: [],
  }
}

function pendingCount(pending: SessionLifecycleSnapshot["pending"]): number {
  return Object.values(pending).reduce((total, ids) => total + ids.length, 0)
}

function snapshot(state: MutableLifecycleState): SessionLifecycleSnapshot {
  return {
    sessionId: state.sessionId,
    mode: state.mode,
    phase: state.phase,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    pending: {
      taskIds: [...state.pending.taskIds],
      workflowIds: [...state.pending.workflowIds],
      commandIds: [...state.pending.commandIds],
      questionIds: [...state.pending.questionIds],
      approvalIds: [...state.pending.approvalIds],
    },
    ...(state.error ? { error: state.error } : {}),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
