import { apiFetch } from "./api"
import type { SessionComposerPreferences } from "./store"

const pendingWrites = new Map<string, Promise<SessionComposerPreferences>>()

/**
 * Serialize preference patches per session so rapid UI changes cannot arrive
 * out of order and overwrite a newer selection with an older request.
 */
export function persistSessionComposerPreferences(
  sessionId: string,
  patch: Partial<SessionComposerPreferences>,
): Promise<SessionComposerPreferences> {
  const previous = pendingWrites.get(sessionId) ?? Promise.resolve({} as SessionComposerPreferences)
  const next = previous.catch(() => ({} as SessionComposerPreferences)).then(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await apiFetch("/api/sessions/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, ...patch }),
        })
        const payload = await response.json().catch(() => ({})) as {
          preferences?: SessionComposerPreferences
          error?: string
        }
        if (response.ok && payload.preferences) return payload.preferences
        const error = new Error(payload.error || `会话设置保存失败: HTTP ${response.status}`)
        if (response.status < 500) throw error
        lastError = error
      } catch (error) {
        lastError = error
      }
      if (attempt < 3) await delay(250 * (attempt + 1))
    }
    throw lastError instanceof Error ? lastError : new Error("会话设置保存失败")
  })
  pendingWrites.set(sessionId, next)
  void next.finally(() => {
    if (pendingWrites.get(sessionId) === next) pendingWrites.delete(sessionId)
  }).catch(() => {})
  return next
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
