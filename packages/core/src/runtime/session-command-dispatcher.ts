import { SessionCommandRepo, type SessionCommandView } from "../store/session-command"
import { TaskRunRepo, type TaskRunView } from "../store/task-run"
import { SESSION_COMMAND_PROCESS_EPOCH } from "./session-command-queue"
import { taskScheduler } from "./task-scheduler"

type CommandExecutor = (request: Request) => Promise<Response>

let timer: ReturnType<typeof setInterval> | null = null
let pumping = false
/**
 * A conversation is a semantic FIFO lane. Keep exactly one command stream in
 * flight per session; relying on the downstream task scheduler alone allows
 * several HTTP/SSE executions for one conversation to exist concurrently and
 * makes the UI project both the active command and its successor as queued.
 */
const inFlightBySession = new Map<string, string>()

export function startSessionCommandDispatcher(execute: CommandExecutor): void {
  if (timer) return
  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      const recovered = SessionCommandRepo.listPending()
        .map((command) => SessionCommandRepo.recoverForProcess(command.requestId, SESSION_COMMAND_PROCESS_EPOCH))
        .filter((command): command is NonNullable<typeof command> => Boolean(command))
      const heads = new Map<string, typeof recovered[number]>()
      for (const command of recovered) {
        if (isTerminal(command.state)) continue
        const current = heads.get(command.sessionId)
        if (!current || command.sessionSeq < current.sessionSeq) heads.set(command.sessionId, command)
      }
      for (const command of heads.values()) {
        if (inFlightBySession.has(command.sessionId)) continue
        if (command.state === "processing") {
          reconcileAbandonedClaim(command)
          continue
        }
        if (command.state === "accepted") {
          reconcileAcceptedRoot(command)
          continue
        }
        if (command.state !== "pending") continue
        inFlightBySession.set(command.sessionId, command.requestId)
        void executeStoredCommand(command.payload, command.requestId, execute)
          .finally(() => {
            if (inFlightBySession.get(command.sessionId) === command.requestId) {
              inFlightBySession.delete(command.sessionId)
            }
          })
      }
    } finally {
      pumping = false
    }
  }
  void pump()
  timer = setInterval(() => void pump(), 250)
  ;(timer as { unref?: () => void }).unref?.()
}

export function stopSessionCommandDispatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function executeStoredCommand(
  payload: string,
  requestId: string,
  execute: CommandExecutor,
): Promise<void> {
  let response: Response
  try {
    response = await execute(new Request("http://eval.internal/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Eval-Command-Dispatcher": SESSION_COMMAND_PROCESS_EPOCH,
      },
      body: payload,
    }))
  } catch (error) {
    SessionCommandRepo.finishPending(
      requestId,
      "failed",
      error instanceof Error ? error.message : String(error),
    )
    return
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    SessionCommandRepo.finishPending(
      requestId,
      "failed",
      `命令执行入口返回 HTTP ${response.status}${detail ? `: ${detail.slice(0, 1_000)}` : ""}`,
    )
    return
  }
  if (!response.body) {
    finishMissingTerminal(requestId, "命令执行入口未返回事件流")
    return
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.text().catch(() => "")
    const command = SessionCommandRepo.get(requestId)
    if (command?.taskId || (command && ["blocked", "completed", "failed", "cancelled"].includes(command.state))) return
    finishMissingTerminal(requestId, "命令执行入口未返回可订阅的事件流")
    return
  }
  const reader = response.body.getReader()
  try {
    while (!(await reader.read()).done) { /* drain execution events */ }
  } finally {
    reader.releaseLock()
  }
  finishMissingTerminal(requestId, "命令事件流已结束，但根任务没有写入终态")
}

function finishMissingTerminal(requestId: string, error: string): void {
  const command = SessionCommandRepo.get(requestId)
  if (command?.state === "pending") {
    SessionCommandRepo.finishPending(requestId, "failed", error)
  }
}

function reconcileAbandonedClaim(command: SessionCommandView): void {
  if (command.ownerEpoch !== SESSION_COMMAND_PROCESS_EPOCH || !command.ownerToken) return
  SessionCommandRepo.finishOwned(
    command.requestId,
    command.ownerToken,
    "failed",
    "命令执行器已退出，但根任务尚未建立",
  )
}

function reconcileAcceptedRoot(command: SessionCommandView): void {
  if (command.ownerEpoch !== SESSION_COMMAND_PROCESS_EPOCH || !command.taskId) return
  const task = TaskRunRepo.get(command.taskId)
  if (!task) {
    SessionCommandRepo.finishAcceptedOwned(
      command.requestId,
      SESSION_COMMAND_PROCESS_EPOCH,
      command.taskId,
      "failed",
      "命令绑定的根任务不存在",
    )
    return
  }
  const terminal = commandTerminalForTask(task)
  if (terminal) {
    SessionCommandRepo.finishAcceptedOwned(
      command.requestId,
      SESSION_COMMAND_PROCESS_EPOCH,
      command.taskId,
      terminal,
      terminal === "completed" ? undefined : task.error || `根任务以 ${task.status} 结束`,
    )
    return
  }
  if (taskScheduler.getTask(task.id)) return
  TaskRunRepo.update({
    ...task,
    status: "interrupted",
    error: task.error || "根任务执行租约已经丢失",
    completedAt: Date.now(),
  })
}

function commandTerminalForTask(
  task: TaskRunView,
): "blocked" | "completed" | "failed" | "cancelled" | null {
  if (task.status === "completed") return "completed"
  if (task.status === "cancelled") return "cancelled"
  if (task.status === "blocked") return "blocked"
  if (task.status === "failed" || task.status === "interrupted") return "failed"
  return null
}

function isTerminal(state: string): boolean {
  return state === "blocked" || state === "completed" || state === "failed" || state === "cancelled"
}
