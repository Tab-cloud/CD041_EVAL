import { invoke } from "@tauri-apps/api/core"
import { fetch as nativeFetch } from "@tauri-apps/plugin-http"
import { fetchWithTransportFallback, type FetchTransport } from "./local-api-transport"

const API_BASE = "http://127.0.0.1:4096"

let tokenPromise: Promise<string> | null = null

async function getToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = invoke<string>("get_agent_token").catch(() => {
      const meta = import.meta as ImportMeta & { env?: Record<string, string> }
      return meta.env?.VITE_EVAL_AGENT_TOKEN ?? ""
    })
  }
  return tokenPromise
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/")) throw new Error(`不允许的 API 路径: ${path}`)
  const token = await getToken()
  const headers = new Headers(init.headers)
  if (token) headers.set("X-Eval-Agent-Token", token)
  const request = { ...init, headers }
  const webTransport: FetchTransport = (input, options) => globalThis.fetch(input, options)
  if (!isTauriRuntime()) return webTransport(`${API_BASE}${path}`, request)

  // WebView2 can fail local release-mode mutations while the sidecar remains
  // healthy. Mutations use Rust HTTP first; reads keep browser streaming and
  // fall back to Rust only for transport exceptions.
  const method = (init.method ?? "GET").toUpperCase()
  const nativeTransport = nativeFetch as FetchTransport
  return method === "GET" || method === "HEAD"
    ? fetchWithTransportFallback(`${API_BASE}${path}`, request, webTransport, nativeTransport)
    : fetchWithTransportFallback(`${API_BASE}${path}`, request, nativeTransport, webTransport)
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}
