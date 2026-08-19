import type { RuntimeEventType } from "./runtime-protocol"

export interface SseEvent {
  id?: number
  event: RuntimeEventType
  data: any
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let event: RuntimeEventType = "heartbeat"
  let id: number | undefined
  let dataLines: string[] = []
  const acceptLine = (rawLine: string): SseEvent | null => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (line === "") {
      const result = dataLines.length > 0
        ? { id, event, data: JSON.parse(dataLines.join("\n")) }
        : null
      event = "heartbeat"
      id = undefined
      dataLines = []
      return result
    }
    if (line.startsWith(":")) return null
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") {
      event = value.trim() as RuntimeEventType
    } else if (field === "id") {
      const parsed = Number(value.trim())
      id = Number.isSafeInteger(parsed) ? parsed : undefined
    } else if (field === "data") {
      dataLines.push(value)
    }
    return null
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const parsed = acceptLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (parsed) yield parsed
        newline = buffer.indexOf("\n")
      }
    }
    buffer += decoder.decode()
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const parsed = acceptLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (parsed) yield parsed
      newline = buffer.indexOf("\n")
    }
    if (buffer.length > 0) {
      const parsed = acceptLine(buffer)
      if (parsed) yield parsed
    }
    const finalEvent = acceptLine("")
    if (finalEvent) yield finalEvent
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export function assertSseStreamCompleted(completed: boolean): void {
  if (!completed) throw new Error("SSE stream ended before terminal done event")
}

export function isSseTransportInterruption(error: unknown, signalAborted = false): boolean {
  if (signalAborted) return true
  const message = error instanceof Error ? error.message : String(error)
  return /network error|failed to fetch|load failed|stream.*(?:closed|ended|interrupted)|connection.*(?:closed|reset)|unexpected end|terminated|request.*cancel(?:led|ed)/i
    .test(message.trim())
}
