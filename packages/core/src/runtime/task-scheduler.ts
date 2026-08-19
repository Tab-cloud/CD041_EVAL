/**
 * Task Scheduler — 多会话并发 + 后台队列 + 优先级调度
 */
import { TaskRunRepo, type TaskRunCreateResult, type TaskRunView } from "../store/task-run"
import { randomUUID } from "node:crypto"
import { logOrchestrationEvent } from "./orchestration-log.ts"
import { resourcesConflict, type ResourceClaims } from "./run-contract.ts"
import { runGraphService } from "./run-graph.ts"
import { workspaceRevisionService } from "./workspace-revision.ts"

// ══════════════════════════════════════════════
// 类型
// ══════════════════════════════════════════════

export interface ScheduledTask {
  id: string
  parentRunId?: string
  requestId?: string
  sessionId: string
  agentId: string
  priority: number    // 1-10, 10 = 最高
  status: "queued" | "running" | "cancelling" | "waiting-approval" | "waiting-delegation" | "safety-quarantine" | "blocked" | "completed" | "failed" | "cancelled" | "interrupted"
  message: string
  workingDir: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  result?: string
  error?: string
  /** 任务类型 */
  type: "chat" | "compile" | "flash" | "background"
  scope?: string
  effort?: string
  modelId?: string
  retryOf?: string
  /** Tasks sharing a lane never run concurrently. Defaults to the conversation lane. */
  laneKey?: string
  /** Cooperative tasks from one workflow may share a lane while excluding other owners. */
  laneOwner?: string
  /** Declared workspace resources used for conflict-aware scheduling. */
  resourceClaims?: ResourceClaims
  /** 进度回调 */
  onProgress?: (text: string) => void
  /** 完成回调 */
  onComplete?: (result: string) => void
  /** 错误回调 */
  onError?: (error: string) => void
  /** 取消回调，用于中止底层模型流或子进程 */
  onCancel?: () => void
}

export interface SchedulerStats {
  queued: number
  running: number
  waitingApproval: number
  waitingDelegation: number
  completed: number
  failed: number
  maxConcurrency: number
}

interface RunGraphControl {
  observeEnqueue(task: ScheduledTask): void
  /** true means the graph implementation persisted task + graph atomically. */
  observeStatus(task: ScheduledTask): boolean | void
  rollbackEnqueue(task: ScheduledTask): void
  recoverInterrupted?(): number
}

type TaskTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked"

interface PendingTerminalIntent {
  status: TaskTerminalStatus
  result?: string
  error?: string
  /** False only while a cancellation request is still waiting for Worker exit. */
  workerExited: boolean
}

// ══════════════════════════════════════════════
// Task Scheduler
// ══════════════════════════════════════════════

export class TaskScheduler {
  private queue: ScheduledTask[] = []
  private running = new Map<string, ScheduledTask>()
  private suspended = new Map<string, ScheduledTask>()
  /** Durable workspace-safety barriers are never part of bounded history. */
  private safetyBarriers = new Map<string, ScheduledTask>()
  /**
   * A Worker terminal event is not a tree terminal event. The intent remains
   * here while any active or safety-quarantined descendant still owns execution state.
   */
  private terminalIntents = new Map<string, PendingTerminalIntent>()
  private maxConcurrency: number
  private history: ScheduledTask[] = []
  private maxHistory: number
  private waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  private persistence?: Pick<typeof TaskRunRepo, "create" | "update" | "markUnfinishedInterrupted">
    & Partial<Pick<typeof TaskRunRepo, "listSafetyBarriers" | "recoverOrphanSafetyBarriers">>
  private workspaceRecovery?: Pick<typeof workspaceRevisionService, "recoverUnsettled">

  constructor(
    maxConcurrency = 4,
    maxHistory = 200,
    persistence?: Pick<typeof TaskRunRepo, "create" | "update" | "markUnfinishedInterrupted">
      & Partial<Pick<typeof TaskRunRepo, "listSafetyBarriers" | "recoverOrphanSafetyBarriers">>,
    private readonly graph?: RunGraphControl,
    workspaceRecovery?: Pick<typeof workspaceRevisionService, "recoverUnsettled">,
  ) {
    this.maxConcurrency = maxConcurrency
    this.maxHistory = maxHistory
    this.persistence = persistence
    this.workspaceRecovery = workspaceRecovery
      ?? (persistence === TaskRunRepo ? workspaceRevisionService : undefined)
  }

  /** 服务启动后调用：把上次未结束的任务标为中断，绝不自动重放副作用。 */
  recoverInterrupted(): number {
    const interrupted = this.graph
      ? (this.graph.recoverInterrupted?.() ?? 0)
      : (this.persistence?.markUnfinishedInterrupted() ?? 0)
    if (this.graph) this.persistence?.markUnfinishedInterrupted()
    this.workspaceRecovery?.recoverUnsettled()
    this.persistence?.recoverOrphanSafetyBarriers?.()
    this.restoreSafetyBarriers()
    return interrupted
  }

  /** 恢复持久化的工作区安全屏障，不重放子任务。 */
  restoreSafetyBarriers(): number {
    const barriers = this.persistence?.listSafetyBarriers?.() ?? []
    let restored = 0
    for (const barrier of barriers) {
      if (this.safetyBarriers.has(barrier.id)) continue
      // Durable safety state is authoritative after a process crash or a
      // projection failure. Remove stale volatile copies before restoring it.
      this.queue = this.queue.filter((task) => task.id !== barrier.id)
      this.running.delete(barrier.id)
      this.suspended.delete(barrier.id)
      this.history = this.history.filter((task) => task.id !== barrier.id)
      this.safetyBarriers.set(barrier.id, {
        ...barrier,
        status: "safety-quarantine",
        laneKey: `conversation:${barrier.sessionId}`,
        laneOwner: barrier.parentRunId ?? barrier.id,
      })
      restored++
    }
    return restored
  }

  /** 提交任务到队列 */
  enqueue(task: Omit<ScheduledTask, "id" | "status" | "createdAt">): ScheduledTask {
    const id = `task-${randomUUID()}`
    const t: ScheduledTask = {
      ...task,
      laneKey: task.laneKey ?? `conversation:${task.sessionId}`,
      laneOwner: task.laneOwner ?? id,
      id,
      status: "queued",
      createdAt: Date.now(),
    }

    // A task without a durable identity must never become runnable.
    this.graph?.observeEnqueue(t)
    try {
      const existing = this.persistCreate(t)
      if (existing) {
        this.graph?.rollbackEnqueue(t)
        return this.getTask(existing.id) ?? existing
      }
    } catch (error) {
      this.graph?.rollbackEnqueue(t)
      throw error
    }
    logTaskEvent(t, "scheduler.enqueued", "任务已进入统一调度队列", { laneKey: t.laneKey, laneOwner: t.laneOwner })

    // 按优先级插入（高优先级在前）
    const idx = this.queue.findIndex((q) => q.priority < t.priority)
    if (idx === -1) this.queue.push(t)
    else this.queue.splice(idx, 0, t)
    // 如果有空闲槽位，立即开始
    this.drain()
    return t
  }

  /** 等待任务真正获得并发槽位。 */
  waitForTurn(taskId: string, signal?: AbortSignal): Promise<void> {
    const task = this.getTask(taskId)
    if (!task) return Promise.reject(new Error(`任务不存在: ${taskId}`))
    if (task.status === "running") return Promise.resolve()
    if (task.status !== "queued") return Promise.reject(abortError())

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort)
      const onAbort = () => {
        cleanup()
        this.cancel(taskId)
        reject(abortError())
      }
      this.waiters.set(taskId, {
        resolve: () => { cleanup(); resolve() },
        reject: (error) => { cleanup(); reject(error) },
      })
      if (signal?.aborted) onAbort()
      else signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  /** 取消任务 */
  cancel(taskId: string): boolean {
    // 队列中
    const qIdx = this.queue.findIndex((t) => t.id === taskId)
    if (qIdx !== -1) {
      const t = this.queue[qIdx]
      this.terminalIntents.set(taskId, {
        status: "cancelled",
        error: "排队任务已取消",
        workerExited: true,
      })
      this.holdForTreeTerminal(t, "cancelling", "取消已请求，等待后代退出")
      this.invokeCallback(t.onCancel)
      this.cancelDescendants(taskId)
      this.tryFinalizeTreeTerminal(taskId)
      return true
    }

    // Running workers enter a distinct cancellation phase. Their lane and
    // resource lease remain held until the worker confirms it has exited.
    const running = this.running.get(taskId)
    if (running) {
      const existing = this.terminalIntents.get(taskId)
      if (running.status === "cancelling" && existing?.status === "cancelled") return true
      this.terminalIntents.set(taskId, {
        status: "cancelled",
        error: "任务已取消，Worker 已确认退出",
        workerExited: !running.onCancel,
      })
      this.commitUpdate(running, {
        status: "cancelling",
        completedAt: undefined,
        error: running.onCancel
          ? "取消已请求，等待 Worker 退出确认"
          : "取消已请求，等待后代退出",
      })
      logTaskEvent(running, "scheduler.cancelling", "已请求取消，继续保留 lane 与资源租约")
      this.cancelDescendants(taskId)
      this.invokeCallback(running.onCancel)
      if (!running.onCancel) {
        this.moveToTreeBarrier(running)
        this.tryFinalizeTreeTerminal(taskId)
      }
      return true
    }

    const suspended = this.suspended.get(taskId)
    if (suspended) {
      const existing = this.terminalIntents.get(taskId)
      if (suspended.status === "cancelling" && existing?.status === "cancelled") return true
      this.terminalIntents.set(taskId, {
        status: "cancelled",
        error: "任务已取消，Worker 已确认退出",
        workerExited: !suspended.onCancel,
      })
      this.commitUpdate(suspended, {
        status: "cancelling",
        completedAt: undefined,
        error: suspended.onCancel
          ? "取消已请求，等待 Worker 退出确认"
          : "取消已请求，等待后代退出",
      })
      logTaskEvent(suspended, "scheduler.cancelling", "已请求取消挂起任务，继续保留 lane 与资源租约")
      this.cancelDescendants(taskId)
      this.invokeCallback(suspended.onCancel)
      if (!suspended.onCancel) this.tryFinalizeTreeTerminal(taskId)
      return true
    }

    const quarantined = this.safetyBarriers.get(taskId)
    if (quarantined) {
      try {
        workspaceRevisionService.rollback(taskId, quarantined.sessionId)
      } catch (error) {
        logTaskEvent(
          quarantined,
          "scheduler.quarantine-cancel-rejected",
          "隔离的 ChangeSet 回滚未完成，资源屏障继续保留",
          { error: error instanceof Error ? error.message : String(error) },
          "error",
        )
        return false
      }
      this.terminalIntents.set(taskId, {
        status: "cancelled",
        error: "安全隔离子任务已在回滚后关闭",
        workerExited: true,
      })
      this.holdForTreeTerminal(quarantined, "cancelling", "取消已请求，等待后代退出")
      this.invokeCallback(quarantined.onCancel)
      this.cancelDescendants(taskId)
      this.tryFinalizeTreeTerminal(taskId)
      return true
    }

    return false
  }

  /**
   * Worker exit acknowledgement is the only transition that releases a
   * cancelling task's lane/resource lease. Repeated cancellation requests are
   * idempotent and can never stand in for this acknowledgement.
   */
  confirmWorkerExit(taskId: string, detail?: string): boolean {
    const task = this.running.get(taskId) ?? this.suspended.get(taskId)
    if (!task || task.status !== "cancelling") return false
    try {
      workspaceRevisionService.rollback(taskId, task.sessionId)
    } catch (error) {
      const rollbackError = error instanceof Error ? error.message : String(error)
      this.commitUpdate(task, {
        status: "safety-quarantine",
        completedAt: undefined,
        result: `Worker 已退出，但取消后的 ChangeSet 自动回滚失败：${rollbackError}`,
        error: rollbackError,
      })
      this.running.delete(taskId)
      this.suspended.delete(taskId)
      this.terminalIntents.delete(taskId)
      this.safetyBarriers.set(taskId, task)
      logTaskEvent(
        task,
        "scheduler.cancellation-quarantined",
        "Worker 已退出，但 ChangeSet 回滚未完成；资源屏障转入安全隔离",
        { error: rollbackError },
        "error",
      )
      this.drain()
      return true
    }
    const intent = this.terminalIntents.get(taskId) ?? {
      status: "cancelled" as const,
      workerExited: false,
    }
    this.terminalIntents.set(taskId, {
      ...intent,
      workerExited: true,
      error: detail
        ? `任务已取消：${detail}`
        : intent.error ?? "任务已取消，Worker 已确认退出",
    })
    this.moveToTreeBarrier(task)
    logTaskEvent(task, "scheduler.worker-exited", "Worker 已退出，等待整棵执行树汇合")
    this.tryFinalizeTreeTerminal(taskId)
    return true
  }

  /** 由 owner 递归关闭仍存活的后代任务，子 Agent 不得脱离根任务继续运行。 */
  cancelDescendants(parentRunId: string): number {
    const directChildren = [
      ...this.queue,
      ...this.running.values(),
      ...this.suspended.values(),
      ...this.safetyBarriers.values(),
    ].filter((task) => task.parentRunId === parentRunId)
    let cancelled = 0
    for (const child of directChildren) {
      if (this.cancel(child.id)) cancelled++
    }
    return cancelled
  }

  /** 标记任务开始执行 */
  startTask(taskId: string): void {
    const t = this.queue.find((q) => q.id === taskId)
    if (!t) return
    this.commitUpdate(t, { status: "running", startedAt: Date.now() })
    this.queue = this.queue.filter((q) => q.id !== taskId)
    this.running.set(t.id, t)
    logTaskEvent(t, "scheduler.started", "任务获得调度槽并开始执行")
  }

  /** 标记任务完成 */
  completeTask(taskId: string, result: string): void {
    const t = this.running.get(taskId)
    if (!t) return
    if (t.status === "cancelling") {
      this.confirmWorkerExit(taskId)
      return
    }
    this.requestTreeTerminal(t, {
      status: "completed",
      result,
      workerExited: true,
    })
  }

  /**
   * Adopt a successful settlement already committed by RunContractRepo.
   * This is an in-memory projection only; it must never perform a second
   * durable transition or reintroduce a second completion gate.
   */
  adoptCompletedSettlement(taskId: string, result: string): boolean {
    const durable = TaskRunRepo.get(taskId)
    const task = this.running.get(taskId)
    if (!durable || durable.status !== "completed") return false
    if (!task || task.status !== "running") {
      return this.history.some((item) => item.id === taskId && item.status === "completed")
    }
    task.status = "completed"
    task.result = durable.result ?? result
    task.error = undefined
    task.completedAt = durable.completedAt ?? Date.now()
    this.running.delete(taskId)
    this.archive(task)
    logTaskEvent(task, "scheduler.settled", "子任务结果已直接回传主 Agent")
    this.drain()
    this.reevaluateAncestors(task)
    this.invokeCallback(task.onComplete, task.result)
    return true
  }

  /**
   * Isolate a child only when workspace cleanup cannot be proven. Normal
   * child results never enter this safety barrier.
   */
  quarantineForSafety(taskId: string, result: string): boolean {
    const queuedIndex = this.queue.findIndex((item) => item.id === taskId)
    const task = this.running.get(taskId)
      ?? this.suspended.get(taskId)
      ?? (queuedIndex >= 0 ? this.queue[queuedIndex] : undefined)
      ?? this.safetyBarriers.get(taskId)
      ?? this.history.find((item) => item.id === taskId)
    if (!task || ["completed", "safety-quarantine"].includes(task.status)) return false
    this.commitUpdate(task, { status: "safety-quarantine", result, completedAt: undefined })
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
    this.running.delete(taskId)
    this.suspended.delete(taskId)
    this.safetyBarriers.delete(taskId)
    this.history = this.history.filter((item) => item.id !== taskId)
    this.waiters.get(taskId)?.reject(abortError())
    this.waiters.delete(taskId)
    logTaskEvent(
      task,
      "scheduler.safety-quarantined",
      "工作区清理未完成，子任务已隔离并等待主 Agent 处理",
      undefined,
      "error",
    )
    this.safetyBarriers.set(task.id, task)
    this.drain()
    return true
  }

  /** 挂起等待用户审批并释放计算槽。 */
  waitForApproval(taskId: string, reason: string): void {
    const task = this.running.get(taskId)
    if (!task || task.status !== "running") return
    this.commitUpdate(task, { status: "waiting-approval", error: reason })
    logTaskEvent(task, "scheduler.waiting-approval", "任务等待用户确认并释放计算槽", { reason })
    this.running.delete(taskId)
    this.suspended.set(taskId, task)
    this.drain()
  }

  /** 审批结束后重新排队；调用方若要继续产生副作用，应使用 resumeTaskAndWait。 */
  resumeTask(taskId: string): void {
    const task = this.suspended.get(taskId)
    if (!task || task.status !== "waiting-approval") return
    this.commitUpdate(task, { status: "queued", error: undefined })
    this.suspended.delete(taskId)
    logTaskEvent(task, "scheduler.resumed", "审批完成，任务重新进入调度队列")
    this.insertQueued(task)
    this.drain()
  }

  async resumeTaskAndWait(taskId: string, signal?: AbortSignal): Promise<void> {
    this.resumeTask(taskId)
    await this.waitForTurn(taskId, signal)
  }

  /** A parent waiting for a child releases compute capacity but retains its conversation lane. */
  waitForDelegation(taskId: string, reason: string): boolean {
    const task = this.running.get(taskId)
    if (!task || task.status !== "running") return false
    this.commitUpdate(task, { status: "waiting-delegation", error: reason })
    logTaskEvent(task, "scheduler.waiting-delegation", "父任务等待子任务并释放计算槽", { reason })
    this.running.delete(taskId)
    this.suspended.set(taskId, task)
    this.drain()
    return true
  }

  async resumeDelegationAndWait(taskId: string, signal?: AbortSignal): Promise<void> {
    const task = this.suspended.get(taskId)
    if (!task || task.status !== "waiting-delegation") return
    this.commitUpdate(task, { status: "queued", error: undefined })
    this.suspended.delete(taskId)
    logTaskEvent(task, "scheduler.delegation-resumed", "子任务返回，父任务重新进入调度队列")
    this.insertQueued(task)
    this.drain()
    await this.waitForTurn(taskId, signal)
  }

  /** 标记任务失败 */
  failTask(taskId: string, error: string): void {
    const t = this.running.get(taskId)
    if (!t) return
    if (t.status === "cancelling") {
      this.confirmWorkerExit(taskId, error)
      return
    }
    this.requestTreeTerminal(t, {
      status: "failed",
      error,
      workerExited: true,
    }, true)
  }

  /** 任务等待用户、权限、硬件或其他外部条件；释放并发槽但不伪装成失败或完成。 */
  blockTask(taskId: string, reason: string): void {
    const task = this.running.get(taskId)
    if (!task) return
    if (task.status === "cancelling") {
      this.confirmWorkerExit(taskId, reason)
      return
    }
    this.requestTreeTerminal(task, {
      status: "blocked",
      error: reason,
      workerExited: true,
    }, true)
  }

  /** 安全预算或时限结束但目标尚未完成；与成功和执行失败都不同。 */
  interruptTask(taskId: string, reason: string): void {
    const task = this.running.get(taskId)
    if (!task) return
    if (task.status === "cancelling") {
      this.confirmWorkerExit(taskId, reason)
      return
    }
    this.requestTreeTerminal(task, {
      status: "interrupted",
      error: reason,
      workerExited: true,
    }, true)
  }

  /** 获取任务状态 */
  getTask(taskId: string): ScheduledTask | undefined {
    return this.running.get(taskId) ?? this.suspended.get(taskId)
      ?? this.safetyBarriers.get(taskId)
      ?? this.queue.find((t) => t.id === taskId) ?? this.history.find((t) => t.id === taskId)
  }

  /** 获取某会话的任务列表 */
  getSessionTasks(sessionId: string): ScheduledTask[] {
    return [
      ...this.queue.filter((t) => t.sessionId === sessionId),
      ...Array.from(this.running.values()).filter((t) => t.sessionId === sessionId),
      ...Array.from(this.suspended.values()).filter((t) => t.sessionId === sessionId),
      ...Array.from(this.safetyBarriers.values()).filter((t) => t.sessionId === sessionId),
      ...this.history.filter((t) => t.sessionId === sessionId),
    ]
  }

  /** 获取统计 */
  getStats(): SchedulerStats {
    return {
      queued: this.queue.length,
      running: this.running.size,
      waitingApproval: [...this.suspended.values()].filter((task) => task.status === "waiting-approval").length,
      waitingDelegation: [...this.suspended.values()].filter((task) => task.status === "waiting-delegation").length,
      completed: this.history.filter((t) => t.status === "completed").length,
      failed: this.history.filter((t) => t.status === "failed" || t.status === "interrupted").length,
      maxConcurrency: this.maxConcurrency,
    }
  }

  /** 获取队列（用于监控面板） */
  getQueue(): ScheduledTask[] { return [...this.queue] }
  getRunning(): ScheduledTask[] { return [...this.running.values(), ...this.suspended.values()] }
  getSafetyBarriers(): ScheduledTask[] { return [...this.safetyBarriers.values()] }

  /**
   * Runtime tool calls share the scheduler's resource fence. This closes the
   * gap where a root Agent could mutate files while a non-cooperative child or
   * an unresolved ChangeSet still owned an overlapping lease.
   */
  findResourceConflicts(runId: string, claims: ResourceClaims | undefined): ScheduledTask[] {
    if (!claims) return []
    return [
      ...this.queue,
      ...this.running.values(),
      ...this.suspended.values(),
      ...this.safetyBarriers.values(),
    ].filter((task) =>
      task.id !== runId && resourcesConflict(task.resourceClaims, claims))
  }

  /** 尝试从队列中取出下一个任务执行 */
  next(): ScheduledTask | undefined {
    if (this.running.size >= this.maxConcurrency) return undefined
    if (this.queue.length === 0) return undefined

    // 取最高优先级（队列已排序），直接置为 running。
    // 注意：不能调 startTask(id) —— 它会按 id 在 queue 里 find，
    // 而此时 task 已 shift 出 queue，find 必失败并提前 return，导致任务丢失。
    const active = [
      ...this.running.values(),
      ...this.suspended.values(),
      ...this.safetyBarriers.values(),
    ]
    const index = this.queue.findIndex((candidate) => !active.some((task) =>
      (task.laneKey === candidate.laneKey && task.laneOwner !== candidate.laneOwner)
      || resourcesConflict(task.resourceClaims, candidate.resourceClaims)))
    if (index < 0) return undefined
    const task = this.queue[index]
    this.commitUpdate(task, { status: "running", startedAt: Date.now() })
    this.queue.splice(index, 1)
    this.running.set(task.id, task)
    logTaskEvent(task, "scheduler.started", "任务获得调度槽并开始执行")
    this.waiters.get(task.id)?.resolve()
    this.waiters.delete(task.id)
    return task
  }

  /** 清空队列 */
  clearQueue(): void {
    const cancelled = [...this.queue]
    for (const t of cancelled) {
      this.commitUpdate(t, { status: "cancelled", completedAt: Date.now() })
      this.queue = this.queue.filter((candidate) => candidate.id !== t.id)
      this.waiters.get(t.id)?.reject(abortError())
      this.waiters.delete(t.id)
      this.archive(t)
      this.invokeCallback(t.onCancel)
    }
  }

  /** 修改最大并发数 */
  setConcurrency(n: number): void {
    this.maxConcurrency = Math.max(1, Math.min(n, 16))
    this.drain()
  }

  // ─── 内部 ───

  private drain(): void {
    while (this.next()) { /* 持续取出直到满或空 */ }
  }

  private insertQueued(task: ScheduledTask): void {
    const index = this.queue.findIndex((candidate) => candidate.priority < task.priority)
    if (index === -1) this.queue.push(task)
    else this.queue.splice(index, 0, task)
  }

  private archive(task: ScheduledTask): void {
    this.history.unshift(task)
    if (this.history.length > this.maxHistory) this.history = this.history.slice(0, this.maxHistory)
  }

  private requestTreeTerminal(
    task: ScheduledTask,
    intent: PendingTerminalIntent,
    cancelDescendants = false,
  ): void {
    this.terminalIntents.set(task.id, intent)
    if (cancelDescendants) this.cancelDescendants(task.id)

    // A tree barrier is meaningful only while a real descendant is still
    // active. Persisting a transient waiting-delegation state for a leaf would
    // split one terminal transition into two commits: if the final commit
    // fails, durable and in-memory state can only roll back to the artificial
    // barrier instead of the running worker. Leaf completion therefore stays
    // one atomic state/graph/event transition.
    if (intent.workerExited && this.activeDescendants(task.id).length === 0) {
      this.tryFinalizeTreeTerminal(task.id)
      return
    }

    const waitingStatus = intent.status === "completed"
      ? "waiting-delegation" as const
      : "cancelling" as const
    const waitingReason = intent.status === "completed"
      ? "Worker 已完成，等待后代任务与安全屏障汇合"
      : `${intent.error ?? "任务结束"}；等待后代 Worker 退出`
    this.holdForTreeTerminal(task, waitingStatus, waitingReason)
    this.tryFinalizeTreeTerminal(task.id)
  }

  /**
   * Move a Worker that has returned into a non-runnable tree barrier. It keeps
   * the conversation lane and resource claims but consumes no compute slot.
   */
  private holdForTreeTerminal(
    task: ScheduledTask,
    status: "waiting-delegation" | "cancelling",
    reason: string,
  ): void {
    const queuedIndex = this.queue.findIndex((candidate) => candidate.id === task.id)
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
    this.running.delete(task.id)
    this.safetyBarriers.delete(task.id)
    this.commitUpdate(task, {
      status,
      completedAt: undefined,
      error: reason,
    })
    this.suspended.set(task.id, task)
    this.waiters.get(task.id)?.reject(abortError())
    this.waiters.delete(task.id)
    logTaskEvent(
      task,
      "scheduler.tree-terminal-wait",
      "Worker 已结束当前执行体，根任务等待整棵执行树汇合",
      { intendedStatus: this.terminalIntents.get(task.id)?.status },
    )
    this.drain()
  }

  private moveToTreeBarrier(task: ScheduledTask): void {
    this.running.delete(task.id)
    this.safetyBarriers.delete(task.id)
    this.suspended.set(task.id, task)
    this.drain()
  }

  private tryFinalizeTreeTerminal(taskId: string): boolean {
    const intent = this.terminalIntents.get(taskId)
    const task = this.getTask(taskId)
    if (!intent || !task || !intent.workerExited) return false
    if (this.activeDescendants(taskId).length > 0) return false

    this.commitUpdate(task, {
      status: intent.status,
      completedAt: Date.now(),
      result: intent.result,
      error: intent.error,
    })
    this.queue = this.queue.filter((candidate) => candidate.id !== taskId)
    this.running.delete(taskId)
    this.suspended.delete(taskId)
    this.safetyBarriers.delete(taskId)
    this.terminalIntents.delete(taskId)
    this.archive(task)
    const event = intent.status === "completed"
      ? ["scheduler.completed", "整棵执行树已通过调度层完成", "info"] as const
      : intent.status === "cancelled"
        ? ["scheduler.cancelled", "Worker 与全部后代已退出，树级租约现已释放", "info"] as const
        : intent.status === "blocked"
          ? ["scheduler.blocked", "整棵执行树等待外部条件", "warning"] as const
          : intent.status === "interrupted"
            ? ["scheduler.interrupted", "整棵执行树在目标完成前被安全中断", "warning"] as const
            : ["scheduler.failed", "整棵执行树执行失败", "error"] as const
    logTaskEvent(task, event[0], event[1], { treeTerminal: true }, event[2])
    this.drain()
    if (intent.status === "completed") this.invokeCallback(task.onComplete, intent.result ?? "")
    else if (intent.status === "failed" || intent.status === "interrupted") {
      this.invokeCallback(task.onError, intent.error ?? "任务未完成")
    }
    this.reevaluateAncestors(task)
    return true
  }

  private activeDescendants(parentRunId: string): ScheduledTask[] {
    const active = [
      ...this.queue,
      ...this.running.values(),
      ...this.suspended.values(),
      ...this.safetyBarriers.values(),
    ]
    return active.filter((candidate) =>
      candidate.id !== parentRunId && this.isDescendantOf(candidate, parentRunId))
  }

  private isDescendantOf(task: ScheduledTask, ancestorRunId: string): boolean {
    const visited = new Set<string>()
    let parentRunId = task.parentRunId
    while (parentRunId && !visited.has(parentRunId)) {
      if (parentRunId === ancestorRunId) return true
      visited.add(parentRunId)
      parentRunId = this.getTask(parentRunId)?.parentRunId
    }
    return false
  }

  private reevaluateAncestors(task: ScheduledTask): void {
    const visited = new Set<string>()
    let parentRunId = task.parentRunId
    while (parentRunId && !visited.has(parentRunId)) {
      visited.add(parentRunId)
      const parent = this.getTask(parentRunId)
      if (!parent) break
      this.tryFinalizeTreeTerminal(parentRunId)
      parentRunId = parent.parentRunId
    }
  }

  private persistCreate(task: ScheduledTask): ScheduledTask | undefined {
    const outcome = this.persistence?.create(task as TaskRunView) as TaskRunCreateResult | void
    if (!outcome || outcome.created) return undefined
    return {
      ...outcome.task,
      laneKey: `conversation:${outcome.task.sessionId}`,
      laneOwner: outcome.task.parentRunId ?? outcome.task.id,
    }
  }

  private persistUpdate(task: ScheduledTask): void {
    const atomicallyPersisted = this.graph?.observeStatus(task) === true
    if (!atomicallyPersisted) this.persistence?.update(task as TaskRunView)
  }

  /**
   * In-memory scheduler state is a projection of durable state. Roll it back
   * when persistence fails so a failed commit cannot leave a "completed"
   * object occupying a running slot.
   */
  private commitUpdate(
    task: ScheduledTask,
    changes: Partial<Pick<ScheduledTask, "status" | "startedAt" | "completedAt" | "result" | "error">>,
  ): void {
    const previous: typeof changes = {}
    for (const key of Object.keys(changes) as Array<keyof typeof changes>) {
      ;(previous as Record<string, unknown>)[key] = task[key]
    }
    Object.assign(task, changes)
    try {
      this.persistUpdate(task)
    } catch (error) {
      Object.assign(task, previous)
      throw error
    }
  }

  private invokeCallback<T>(callback: ((value: T) => void) | undefined, value: T): void
  private invokeCallback(callback: (() => void) | undefined): void
  private invokeCallback<T>(callback: ((value?: T) => void) | undefined, value?: T): void {
    try { callback?.(value) } catch { /* 外部回调失败不影响调度器终态 */ }
  }
}

function logTaskEvent(
  task: ScheduledTask,
  eventType: string,
  message: string,
  data: Record<string, unknown> = {},
  level: "debug" | "info" | "warning" | "error" = "info",
): void {
  logOrchestrationEvent({
    sessionId: task.sessionId, runId: task.id, agentId: task.agentId,
    parentRunId: task.parentRunId,
    eventType, level, message,
    data: {
      status: task.status,
      type: task.type,
      priority: task.priority,
      resourceClaims: task.resourceClaims,
      ...data,
    },
  })
}

export const taskScheduler = new TaskScheduler(4, 200, TaskRunRepo, runGraphService)

function abortError(): Error {
  const error = new Error("任务已取消")
  error.name = "AbortError"
  return error
}
