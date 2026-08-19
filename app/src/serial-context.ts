import type { LogLine } from "./store"
import type { SerialContextPayload } from "./types"

export type { SerialContextPayload } from "./types"

const MAX_SERIAL_LINES = 200
const MAX_SERIAL_CHARS = 12_000

/** Build a bounded snapshot from the latest serial connection for one AI turn. */
export function buildSerialContextPayload(
  output: LogLine[],
  port: string | null,
  baudRate: number,
): SerialContextPayload | undefined {
  if (output.length === 0) return undefined
  let latestConnection = -1
  for (let index = output.length - 1; index >= 0; index--) {
    if (/^\[连接\s|^\[Connected\s/i.test(output[index].text.trim())) {
      latestConnection = index
      break
    }
  }
  const source = latestConnection >= 0 ? output.slice(latestConnection) : output
  const lines: string[] = []
  let chars = 0

  for (let index = source.length - 1; index >= 0 && lines.length < MAX_SERIAL_LINES; index--) {
    const item = source[index]
    const text = item.text.split("\u0000").join("").trim().slice(0, 1_000)
    if (!text) continue
    const timestamp = new Date(item.timestamp).toISOString()
    const rendered = `[${timestamp}] [${item.type}] ${text}`
    if (chars + rendered.length > MAX_SERIAL_CHARS) {
      const remaining = MAX_SERIAL_CHARS - chars
      if (remaining > 80) lines.unshift(rendered.slice(-remaining))
      break
    }
    lines.unshift(rendered)
    chars += rendered.length
  }

  if (lines.length === 0) return undefined
  return { port: port ?? "unknown", baudRate, capturedAt: Date.now(), lines }
}
