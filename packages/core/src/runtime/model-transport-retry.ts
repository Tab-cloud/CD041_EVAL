import { classifyModelFailure } from "./model-failure-policy.ts"

const DEFAULT_REQUEST_MAX_RETRIES = 4
const DEFAULT_STREAM_MAX_RETRIES = 5
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 8_000

export interface ModelTransportRetry {
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: string
  failureKind: "request" | "stream"
}

/**
 * Codex-style bounded reconnect policy. Retry count is distinct from total
 * attempts: request failures allow four retries, stream interruptions five.
 */
export function nextModelTransportRetry(
  error: string,
  completedRetries: number,
  random: () => number = Math.random,
): ModelTransportRetry | undefined {
  const failure = classifyModelFailure(error)
  if (!failure.retryable) return undefined
  const stream = failure.kind === "transient-stream"
  const maxRetries = configuredInteger(
    stream ? "EVAL_MODEL_STREAM_MAX_RETRIES" : "EVAL_MODEL_REQUEST_MAX_RETRIES",
    stream ? DEFAULT_STREAM_MAX_RETRIES : DEFAULT_REQUEST_MAX_RETRIES,
    0,
    20,
  )
  if (completedRetries >= maxRetries) return undefined
  const baseDelay = configuredInteger("EVAL_MODEL_RETRY_BASE_MS", DEFAULT_BASE_DELAY_MS, 0, 60_000)
  const maxDelay = configuredInteger("EVAL_MODEL_RETRY_MAX_MS", DEFAULT_MAX_DELAY_MS, 0, 120_000)
  const exponential = Math.min(maxDelay, baseDelay * (2 ** completedRetries))
  const jitter = exponential === 0 ? 0 : Math.round(exponential * (0.8 + Math.max(0, Math.min(1, random())) * 0.4))
  return {
    attempt: completedRetries + 1,
    maxAttempts: maxRetries,
    delayMs: jitter,
    reason: failure.summary,
    failureKind: stream ? "stream" : "request",
  }
}

export async function waitForModelTransportRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal)
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(abortReason(signal))
    }
    function finish() {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function configuredInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("模型调用已取消")
}
