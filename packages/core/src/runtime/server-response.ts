export function json(data: unknown, extraHeaders?: Record<string, unknown>): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  let status = 200
  for (const [key, value] of Object.entries(extraHeaders ?? {})) {
    if (key === "status" && typeof value === "number") status = value
    else if (typeof value === "string") headers[key] = value
  }
  return new Response(JSON.stringify(data), { status, headers })
}
