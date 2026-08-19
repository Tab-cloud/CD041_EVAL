import { invoke } from "@tauri-apps/api/core"
import { fetch as nativeFetch } from "@tauri-apps/plugin-http"
import { apiFetch } from "./api"

export const EVAL_WEB_ORIGIN = "https://eval.zailink.space"

export const COMMUNITY_SCOPES = [
  "community.forum.read",
  "community.forum.topic.create",
  "community.forum.reply.create",
  "community.blog.draft.create",
  "community.blog.publish",
] as const

export type CommunityScope = typeof COMMUNITY_SCOPES[number]

export interface CommunityCapabilities {
  enabled: boolean
  scopes: CommunityScope[]
  limits: {
    forumTopicsPerHour: number
    forumRepliesPerHour: number
    blogDraftsPerDay: number
    blogPublishesPerDay: number
  }
  identity: { userId: string; displayName: string; deviceSessionId: string }
  policyVersion: number
}

export async function syncCommunityRuntimeToken(token?: string): Promise<boolean> {
  const value = token ?? await invoke<string | null>("read_account_token")
  if (!value) {
    await clearCommunityRuntimeToken()
    return false
  }
  const response = await apiFetch("/api/runtime/community-session", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: value }),
  })
  if (!response.ok) throw new Error(await localApiError(response, "无法同步社区账号凭据"))
  return true
}

export async function clearCommunityRuntimeToken(): Promise<void> {
  const response = await apiFetch("/api/runtime/community-session", { method: "DELETE" })
  if (!response.ok) throw new Error(await localApiError(response, "无法清除社区账号凭据"))
}

export async function loadCommunityCapabilities(): Promise<CommunityCapabilities | null> {
  const token = await invoke<string | null>("read_account_token")
  if (!token) return null
  await syncCommunityRuntimeToken(token).catch(() => undefined)
  const response = await communityFetch("/api/v1/agent/community/capabilities", token)
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (response.status === 401) {
    await clearCommunityRuntimeToken().catch(() => undefined)
    await invoke("delete_account_token").catch(() => undefined)
    return null
  }
  if (!response.ok) throw new Error(remoteApiError(payload, response.status))
  return normalizeCapabilities(payload)
}

async function communityFetch(path: string, token: string): Promise<Response> {
  if (!path.startsWith("/api/v1/agent/community/")) throw new Error("社区 API 路径无效")
  const transport = isTauriRuntime() ? nativeFetch : globalThis.fetch
  return transport(`${EVAL_WEB_ORIGIN}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-store",
    },
  })
}

function normalizeCapabilities(value: Record<string, unknown>): CommunityCapabilities {
  const identity = objectOf(value.identity)
  const limits = objectOf(value.limits)
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((scope): scope is CommunityScope => COMMUNITY_SCOPES.includes(scope as CommunityScope))
    : []
  if (!identity || !limits || typeof identity.userId !== "string" || typeof identity.displayName !== "string"
    || typeof identity.deviceSessionId !== "string") throw new Error("社区能力信息格式无效")
  return {
    enabled: value.enabled === true,
    scopes,
    limits: {
      forumTopicsPerHour: boundedNumber(limits.forumTopicsPerHour),
      forumRepliesPerHour: boundedNumber(limits.forumRepliesPerHour),
      blogDraftsPerDay: boundedNumber(limits.blogDraftsPerDay),
      blogPublishesPerDay: boundedNumber(limits.blogPublishesPerDay),
    },
    identity: {
      userId: identity.userId,
      displayName: identity.displayName,
      deviceSessionId: identity.deviceSessionId,
    },
    policyVersion: boundedNumber(value.policyVersion),
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedNumber(value: unknown): number {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0
}

async function localApiError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: unknown }
  return typeof payload.error === "string" ? payload.error : `${fallback}（HTTP ${response.status}）`
}

function remoteApiError(payload: Record<string, unknown>, status: number): string {
  const error = objectOf(payload.error)
  return typeof error?.message === "string" ? error.message : `社区服务返回 HTTP ${status}`
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}
