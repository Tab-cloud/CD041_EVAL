import { describe, expect, test } from "bun:test"
import { compactDividerAfterIndex } from "../src/chat-timeline.ts"

describe("chat compaction timeline", () => {
  test("anchors the marker to the authoritative summarized sequence", () => {
    const messages = [
      { role: "user" as const, content: "a", seq: 1, timestamp: 100 },
      { role: "assistant" as const, content: "b", seq: 2, timestamp: 200 },
      { role: "user" as const, content: "c", seq: 3, timestamp: 400 },
    ]
    expect(compactDividerAfterIndex(messages, { content: "摘要", timestamp: 300, throughSeq: 2 })).toBe(1)
  })

  test("falls back to timestamp for live and legacy messages without a sequence", () => {
    const messages = [
      { role: "user" as const, content: "a", timestamp: 100 },
      { role: "assistant" as const, content: "b", timestamp: 200 },
      { role: "user" as const, content: "c", timestamp: 400 },
    ]
    expect(compactDividerAfterIndex(messages, { content: "摘要", timestamp: 300 })).toBe(1)
  })
})
