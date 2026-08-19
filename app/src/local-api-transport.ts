export type FetchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * A failed transport is retried through the alternate desktop channel. HTTP
 * responses, including 4xx/5xx, are returned unchanged and are never replayed.
 */
export async function fetchWithTransportFallback(
  input: string | URL | Request,
  init: RequestInit,
  primary: FetchTransport,
  fallback?: FetchTransport,
): Promise<Response> {
  try {
    return await primary(input, init)
  } catch (primaryError) {
    if (!fallback) throw primaryError
    try {
      return await fallback(input, init)
    } catch (fallbackError) {
      throw new LocalApiTransportError(primaryError, fallbackError)
    }
  }
}

export class LocalApiTransportError extends Error {
  constructor(
    readonly primaryError: unknown,
    readonly fallbackError: unknown,
  ) {
    super(`本地 API 的 WebView 与原生传输均失败：${errorText(primaryError)}；${errorText(fallbackError)}`)
    this.name = "LocalApiTransportError"
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
