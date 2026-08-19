import { invoke } from "@tauri-apps/api/core"
import { fetch as nativeFetch } from "@tauri-apps/plugin-http"
import appPackage from "../package.json"
import { clearCommunityRuntimeToken, COMMUNITY_SCOPES, EVAL_WEB_ORIGIN, syncCommunityRuntimeToken } from "./community"

const ACCOUNT_ORIGIN = EVAL_WEB_ORIGIN
const ACCOUNT_LOGIN_URL = `${ACCOUNT_ORIGIN}/login?returnTo=${encodeURIComponent("/console")}`

export class DesktopAccountBindingUnavailableError extends Error {
  constructor() {
    super("当前账号服务尚未启用桌面绑定")
    this.name = "DesktopAccountBindingUnavailableError"
  }
}

export interface AccountUser {
  id: string
  username: string | null
  email: string | null
  phoneE164: string | null
  accountLocale: "zh" | "en"
  displayName: string
  role: "admin" | "member"
}

export interface AccountBinding {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export type AccountLoginResult =
  | { mode: "desktop-binding"; binding: AccountBinding }
  | { mode: "web" }

export function accountBindingAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function loadAccountProfile(): Promise<AccountUser | null> {
  if (!accountBindingAvailable()) return null
  const token = await invoke<string | null>("read_account_token")
  if (!token) return null
  await syncCommunityRuntimeToken(token).catch(() => undefined)
  const response = await accountFetch("/api/auth/desktop/me", { method: "GET" }, token)
  if (response.status === 401) {
    await clearCommunityRuntimeToken().catch(() => undefined)
    await invoke("delete_account_token")
    return null
  }
  if (desktopBindingEndpointUnavailable(response.status)) {
    throw new DesktopAccountBindingUnavailableError()
  }
  const payload = await response.json().catch(() => ({})) as { user?: unknown; error?: string }
  if (!response.ok) throw new Error(payload.error || `账号服务返回 HTTP ${response.status}`)
  return normalizeAccountUser(payload.user)
}

export async function beginAccountBinding(): Promise<AccountBinding> {
  if (!accountBindingAvailable()) throw new Error("账号绑定仅在 Eval 桌面端可用")
  const response = await accountFetch("/api/auth/desktop/device", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceName: "Windows 设备",
      clientVersion: appPackage.version,
      requestedScopes: COMMUNITY_SCOPES,
    }),
  })
  if (desktopBindingEndpointUnavailable(response.status)) {
    throw new DesktopAccountBindingUnavailableError()
  }
  const payload = await response.json().catch(() => ({})) as Partial<AccountBinding> & { error?: string }
  if (!response.ok) throw new Error(payload.error || `账号服务返回 HTTP ${response.status}`)
  const binding = normalizeBinding(payload)
  await openAccountBinding(binding.verificationUriComplete)
  return binding
}

export async function beginAccountLogin(): Promise<AccountLoginResult> {
  try {
    return { mode: "desktop-binding", binding: await beginAccountBinding() }
  } catch (error) {
    if (!(error instanceof DesktopAccountBindingUnavailableError)) throw error
    await openAccountLogin()
    return { mode: "web" }
  }
}

export async function openAccountLogin(): Promise<void> {
  await openAccountBinding(ACCOUNT_LOGIN_URL)
}

export async function openAccountBinding(url: string): Promise<void> {
  if (!accountBindingAvailable()) throw new Error("无法调用系统浏览器")
  await invoke("open_account_url", { url })
}

export async function pollAccountBinding(deviceCode: string): Promise<AccountUser | null> {
  const response = await accountFetch("/api/auth/desktop/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  })
  const payload = await response.json().catch(() => ({})) as {
    accessToken?: unknown
    user?: unknown
    code?: string
    error?: string
  }
  if (response.status === 428 && payload.code === "authorization_pending") return null
  if (!response.ok) throw new Error(payload.error || `账号绑定失败（HTTP ${response.status}）`)
  if (typeof payload.accessToken !== "string" || !payload.accessToken.startsWith("eval_dt_")) {
    throw new Error("账号服务返回了无效的桌面凭据")
  }
  const user = normalizeAccountUser(payload.user)
  try {
    await invoke("save_account_token", { token: payload.accessToken })
  } catch (error) {
    await invoke("delete_account_token").catch(() => undefined)
    await accountFetch("/api/auth/desktop/logout", { method: "POST" }, payload.accessToken).catch(() => undefined)
    throw new Error(`无法安全保存账号凭据：${messageOf(error)}`)
  }
  await syncCommunityRuntimeToken(payload.accessToken).catch(() => undefined)
  return user
}

export async function logoutAccount(): Promise<void> {
  if (!accountBindingAvailable()) return
  const token = await invoke<string | null>("read_account_token").catch(() => null)
  await clearCommunityRuntimeToken().catch(() => undefined)
  if (token) await accountFetch("/api/auth/desktop/logout", { method: "POST" }, token).catch(() => undefined)
  await invoke("delete_account_token")
}

export function normalizeAccountUser(value: unknown): AccountUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("账号资料格式无效")
  const record = value as Record<string, unknown>
  const role = record.role
  if (
    typeof record.id !== "string"
    || typeof record.displayName !== "string"
    || (record.username != null && typeof record.username !== "string")
    || (record.email != null && typeof record.email !== "string")
    || (record.phoneE164 != null && typeof record.phoneE164 !== "string")
    || !["zh", "en"].includes(String(record.accountLocale))
    || !["admin", "member"].includes(String(role))
  ) throw new Error("账号资料格式无效")
  return {
    id: record.id,
    username: typeof record.username === "string" ? record.username : null,
    email: typeof record.email === "string" ? record.email : null,
    phoneE164: typeof record.phoneE164 === "string" ? record.phoneE164 : null,
    accountLocale: record.accountLocale as AccountUser["accountLocale"],
    displayName: record.displayName,
    role: role as AccountUser["role"],
  }
}

export function accountInitial(user: Pick<AccountUser, "username" | "displayName">): string {
  for (const source of [user.username, user.displayName]) {
    if (!source) continue
    const initial = Array.from(source.trim()).find((character) => /[\p{L}\p{N}]/u.test(character))
    if (initial) return initial.toLocaleUpperCase()
  }
  return "?"
}

export function desktopBindingEndpointUnavailable(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

function normalizeBinding(value: Partial<AccountBinding>): AccountBinding {
  if (
    typeof value.deviceCode !== "string"
    || typeof value.userCode !== "string"
    || typeof value.verificationUri !== "string"
    || typeof value.verificationUriComplete !== "string"
    || !Number.isFinite(value.expiresIn)
    || !Number.isFinite(value.interval)
  ) throw new Error("账号服务返回了无效的设备绑定信息")
  for (const address of [value.verificationUri, value.verificationUriComplete]) {
    const parsed = new URL(address)
    if (parsed.origin !== ACCOUNT_ORIGIN) throw new Error("账号服务返回了不受信任的登录地址")
  }
  return {
    deviceCode: value.deviceCode,
    userCode: value.userCode,
    verificationUri: value.verificationUri,
    verificationUriComplete: value.verificationUriComplete,
    expiresIn: Math.max(30, Math.min(900, Math.round(value.expiresIn!))),
    interval: Math.max(2, Math.min(10, Math.round(value.interval!))),
  }
}

async function accountFetch(path: string, init: RequestInit, token?: string): Promise<Response> {
  if (!path.startsWith("/api/auth/desktop/")) throw new Error("账号 API 路径无效")
  const headers = new Headers(init.headers)
  headers.set("Accept", "application/json")
  headers.set("Cache-Control", "no-store")
  if (token) headers.set("Authorization", `Bearer ${token}`)
  const transport = accountBindingAvailable() ? nativeFetch : globalThis.fetch
  return transport(`${ACCOUNT_ORIGIN}${path}`, { ...init, headers })
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
