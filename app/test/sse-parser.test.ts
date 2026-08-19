import { describe, expect, test } from "bun:test"
import {
  assertSseStreamCompleted,
  isSseTransportInterruption,
  readSse,
} from "../src/sse"

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe("SSE parser", () => {
  test("reassembles split chunks, CRLF and multiline data", async () => {
    const events = []
    for await (const event of readSse(streamFromChunks([
      ": keepalive\r\nid: 7\r\nevent: task-status\r\ndata: {\"status\":\r\n",
      "data: \"running\"}\r\n\r\n",
    ]))) events.push(event)

    expect(events).toEqual([{ id: 7, event: "task-status", data: { status: "running" } }])
  })

  test("flushes a final event without a trailing blank line", async () => {
    const events = []
    for await (const event of readSse(streamFromChunks([
      'event: done\ndata: {"status":"completed"}',
    ]))) events.push(event)

    expect(events).toEqual([{ event: "done", data: { status: "completed" } }])
  })

  test("requires an authoritative terminal done event", () => {
    expect(() => assertSseStreamCompleted(true)).not.toThrow()
    expect(() => assertSseStreamCompleted(false)).toThrow("terminal done event")
  })

  test("recognizes native Tauri cancellation and watchdog aborts", () => {
    expect(isSseTransportInterruption("request was cancelled")).toBe(true)
    expect(isSseTransportInterruption(new Error("unrelated"), true)).toBe(true)
    expect(isSseTransportInterruption(new Error("validation failed"))).toBe(false)
  })
})
