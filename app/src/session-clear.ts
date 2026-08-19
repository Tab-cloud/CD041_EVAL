import { apiFetch } from "./api"

type ApiTransport = (path: string, init?: RequestInit) => Promise<Response>

export interface SessionClearResult {
  success: true
  artifactRevision: number
}

export interface SessionClearOptions {
  fetcher?: ApiTransport
  maxAttempts?: number
  retryDelayMs?: number
  wait?: (milliseconds: number) => Promise<void>
}

/**
 * Clears one durable conversation aggregate. A 202 response means the runtime
 * is still cancelling live work, not that the clear has completed.
 */
export async function clearSessionConversation(
  sessionId: string,
  options: SessionClearOptions = {},
): Promise<SessionClearResult> {
  const fetcher = options.fetcher ?? apiFetch
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 6))
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 250))
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetcher("/api/sessions/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    })
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean
      artifactRevision?: number
      error?: string
    }
    if (response.status === 202) {
      if (attempt === maxAttempts) {
        throw new Error("会话仍在结束当前任务，请稍后重试 /clear")
      }
      await wait(retryDelayMs)
      continue
    }
    // An optimistic/stale local session has no durable context to preserve.
    // Clearing its renderer state is therefore safe even if the sidecar no
    // longer has a matching session row.
    if (response.status === 404) {
      return { success: true, artifactRevision: 0 }
    }
    if (!response.ok || payload.success !== true) {
      throw new Error(payload.error || `清除会话失败: HTTP ${response.status}`)
    }
    return {
      success: true,
      artifactRevision: Number(payload.artifactRevision) || 0,
    }
  }

  throw new Error("清除会话未完成")
}
