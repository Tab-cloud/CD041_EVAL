import { invoke } from "@tauri-apps/api/core"
import { EVAL_WEB_ORIGIN } from "./community"

const EVAL_COMMUNITY_PATH = /^\/?(?:blog|forum)(?:[/?#]|$)/i

export function resolveExternalWebUrl(href: string): string | null {
  const value = href.trim()
  if (!value) return null
  try {
    const candidate = EVAL_COMMUNITY_PATH.test(value)
      ? new URL(value.startsWith("/") ? value : `/${value}`, EVAL_WEB_ORIGIN)
      : new URL(value)
    if (!['http:', 'https:'].includes(candidate.protocol)) return null
    if (candidate.username || candidate.password) return null
    return candidate.toString()
  } catch {
    return null
  }
}

export async function openExternalWebUrl(href: string): Promise<void> {
  const url = resolveExternalWebUrl(href)
  if (!url) throw new Error("外部网页地址无效")
  if (isTauriRuntime()) {
    await invoke("open_external_url", { url })
    return
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer")
  if (!opened) throw new Error("浏览器阻止了新窗口")
  opened.opener = null
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}
