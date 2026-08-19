import { timingSafeEqual } from "node:crypto"

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
])

function allowedOrigins(): Set<string> {
  const configured = (process.env.EVAL_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured])
}

export function getCors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin")
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Eval-Agent-Token",
    "Vary": "Origin",
  }
  if (origin && allowedOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin
  }
  return headers
}

export function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin")
  return !origin || allowedOrigins().has(origin)
}

export function hasValidToken(req: Request): boolean {
  const expected = process.env.EVAL_AGENT_TOKEN?.trim()
  if (!expected) return process.env.EVAL_ALLOW_UNAUTHENTICATED === "1"
  const actual = req.headers.get("x-eval-agent-token") ?? ""
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
}
