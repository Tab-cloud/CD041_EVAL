import { useEffect, useRef, useState, type Dispatch } from "react"
import type {
  AppAction,
  AppState,
  LogLine,
  QueuedInstruction,
} from "../store"
import {
  commandToInstruction,
  commandToRun,
  isRetryableSessionCommandError,
  submitSessionCommand,
} from "../session-commands"
import {
  SessionCommandConsumerLedger,
  startDurableSessionInstructionSubscription,
} from "../session-command-consumer"

interface SessionCommandQueueState {
  activeSessionId: AppState["activeSessionId"]
  instructionQueue: AppState["instructionQueue"]
  runsBySession: AppState["runsBySession"]
  sessionCommandsHydrated: AppState["sessionCommandsHydrated"]
}

interface SessionCommandQueueOptions {
  state: SessionCommandQueueState
  dispatch: Dispatch<AppAction>
  addAgentLog: (
    sessionId: string | null,
    text: string,
    type: LogLine["type"],
  ) => void
  subscribe: (instruction: QueuedInstruction) => Promise<void>
}

/**
 * Bridges the durable server command queue to one renderer transport.
 *
 * Server hydration is the admission boundary for both recovering local
 * submissions and attaching SSE. The process-local refs are only leases and
 * never decide FIFO order or completion.
 */
export function useSessionCommandQueue({
  state,
  dispatch,
  addAgentLog,
  subscribe,
}: SessionCommandQueueOptions): void {
  const submitting = useRef(new Set<string>())
  const retryAttempts = useRef(new Map<string, number>())
  const retryTimers = useRef(new Map<string, number>())
  const [retryRevision, setRetryRevision] = useState(0)
  const consumers = useRef(new SessionCommandConsumerLedger())

  useEffect(() => {
    // Local acceptance must not wait for a global queue snapshot. The POST is
    // request-idempotent and the server remains the FIFO authority, so a
    // temporarily unavailable hydration read cannot strand the user's work.
    const instructions = selectLocalInstructionsForSubmission(
      state.instructionQueue,
      submitting.current,
    )
    for (const instruction of instructions) {
      submitting.current.add(instruction.requestId)
      const retryTimer = retryTimers.current.get(instruction.requestId)
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
        retryTimers.current.delete(instruction.requestId)
      }
      dispatch({
        type: "UPSERT_QUEUED_INSTRUCTION",
        instruction: {
          ...instruction,
          submissionState: "sending",
          submissionError: undefined,
          submissionRetryAt: undefined,
        },
      })
      void submitSessionCommand(instruction).then((command) => {
        const recoveredAfter = retryAttempts.current.get(instruction.requestId) ?? 0
        retryAttempts.current.delete(instruction.requestId)
        const persisted = commandToInstruction(command, instruction)
        const run = commandToRun(command)
        if (instruction.branchFrom && instruction.sessionId) {
          dispatch({
            type: "APPLY_CONVERSATION_BRANCH",
            sessionId: instruction.sessionId,
            target: instruction.branchFrom,
          })
        }
        if (run) dispatch({ type: "UPSERT_SESSION_RUN", run })
        dispatch({ type: "UPSERT_QUEUED_INSTRUCTION", instruction: persisted })
        if (recoveredAfter > 0) {
          addAgentLog(instruction.sessionId, "本地 Agent 已恢复，指令已继续发送", "success")
        }
      }).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        if (!isRetryableSessionCommandError(error)) {
          retryAttempts.current.delete(instruction.requestId)
          dispatch({
            type: "UPSERT_QUEUED_INSTRUCTION",
            instruction: {
              ...instruction,
              submissionState: "failed",
              submissionError: detail,
              submissionRetryAt: undefined,
            },
          })
          addAgentLog(
            instruction.sessionId,
            `任务未提交：${detail}`,
            "error",
          )
          return
        }
        const attempt = (retryAttempts.current.get(instruction.requestId) ?? 0) + 1
        retryAttempts.current.set(instruction.requestId, attempt)
        const delayMs = sessionCommandRetryDelay(attempt)
        const retryAt = Date.now() + delayMs
        const timer = window.setTimeout(() => {
          retryTimers.current.delete(instruction.requestId)
          setRetryRevision((revision) => revision + 1)
        }, delayMs)
        retryTimers.current.set(instruction.requestId, timer)
        dispatch({
          type: "UPSERT_QUEUED_INSTRUCTION",
          instruction: {
            ...instruction,
            submissionState: "retrying",
            submissionError: detail,
            submissionRetryAt: retryAt,
          },
        })
        addAgentLog(
          instruction.sessionId,
          `本地 Agent 暂时未接收指令，${formatRetryDelay(delayMs)}后自动重试：${detail}`,
          "warning",
        )
      }).finally(() => {
        submitting.current.delete(instruction.requestId)
        // Continue draining local FIFO entries explicitly. Do not depend on an
        // unrelated poll or UI state change to wake the next submission.
        setRetryRevision((revision) => revision + 1)
      })
    }
  }, [
    addAgentLog,
    dispatch,
    retryRevision,
    state.instructionQueue,
  ])

  useEffect(() => () => {
    for (const timer of retryTimers.current.values()) window.clearTimeout(timer)
    retryTimers.current.clear()
  }, [])

  useEffect(() => {
    const sessionId = state.activeSessionId
    startDurableSessionInstructionSubscription({
      ledger: consumers.current,
      queue: state.instructionQueue,
      sessionId,
      run: sessionId ? state.runsBySession[sessionId] : undefined,
      hydrated: state.sessionCommandsHydrated,
      subscribe,
    })
  }, [
    state.activeSessionId,
    state.instructionQueue,
    state.runsBySession,
    state.sessionCommandsHydrated,
    subscribe,
  ])
}

export function sessionCommandRetryDelay(attempt: number): number {
  const normalized = Math.max(1, Math.floor(attempt))
  return Math.min(1_000 * 2 ** (normalized - 1), 15_000)
}

export function selectLocalInstructionsForSubmission(
  queue: QueuedInstruction[],
  submittingRequestIds: ReadonlySet<string>,
  now = Date.now(),
): QueuedInstruction[] {
  const headBySession = new Map<string, QueuedInstruction>()
  for (const instruction of queue) {
    if (!instruction.sessionId
      || instruction.serverState !== "local"
      || instruction.submissionState === "failed"
      || headBySession.has(instruction.sessionId)) continue
    headBySession.set(instruction.sessionId, instruction)
  }
  const submittingSessions = new Set(queue
    .filter((instruction) => submittingRequestIds.has(instruction.requestId))
    .map((instruction) => instruction.sessionId))
  return [...headBySession.values()].filter((instruction) =>
    !submittingRequestIds.has(instruction.requestId)
    && !submittingSessions.has(instruction.sessionId)
    && (!instruction.submissionRetryAt || instruction.submissionRetryAt <= now))
}

function formatRetryDelay(delayMs: number): string {
  return delayMs >= 1_000 ? `${Math.round(delayMs / 1_000)} 秒` : `${delayMs} 毫秒`
}
