import { randomUUID } from "node:crypto"
import { SessionCommandRepo, type SessionCommandView } from "../store/session-command"
import { ensureRuntimeOwnerLease } from "./runtime-owner-lease"

const CLAIM_POLL_MS = 50
export const SESSION_COMMAND_PROCESS_EPOCH = randomUUID()
ensureRuntimeOwnerLease(SESSION_COMMAND_PROCESS_EPOCH)

export async function acquireSessionCommand(
  requestId: string,
  ownerToken: string,
  signal?: AbortSignal,
): Promise<SessionCommandView> {
  while (!signal?.aborted) {
    const existing = SessionCommandRepo.recoverForProcess(requestId, SESSION_COMMAND_PROCESS_EPOCH)
    if (!existing) throw new Error("会话命令不存在")
    if (existing.taskId || ["blocked", "completed", "failed", "cancelled"].includes(existing.state)) return existing
    const claimed = SessionCommandRepo.tryClaim(requestId, ownerToken, SESSION_COMMAND_PROCESS_EPOCH)
    if (claimed) return claimed
    await wait(CLAIM_POLL_MS, signal)
  }
  throw abortError()
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

function abortError(): Error {
  const error = new Error("请求已中止")
  error.name = "AbortError"
  return error
}
