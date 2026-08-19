import { describe, expect, test } from "bun:test"
import {
  contextUsageAfterCompaction,
  normalizeCompactSummary,
  normalizeContextUsage,
} from "../src/context-state.ts"

describe("Context Tab state", () => {
  test("preserves authoritative compaction metadata", () => {
    expect(normalizeCompactSummary({
      content: "摘要内容",
      timestamp: 1234,
      throughSeq: 18,
      mode: "auto",
      originalTokens: 90_000,
      compactedTokens: 24_000,
    })).toEqual({
      content: "摘要内容",
      timestamp: 1234,
      throughSeq: 18,
      mode: "auto",
      originalTokens: 90_000,
      compactedTokens: 24_000,
    })
  })

  test("rejects malformed persisted snapshots", () => {
    expect(normalizeContextUsage({ used: -1, total: 0, breakdown: {} })).toBeNull()
    expect(normalizeCompactSummary({ content: "", timestamp: 0 })).toBeNull()
  })

  test("preserves the independent protocol message budget", () => {
    const value = normalizeContextUsage({
      used: 12_000,
      total: 800_000,
      breakdown: { messages: 10_000, systemTools: 1_000, skills: 0, systemPrompt: 1_000, other: 0 },
      protocolMessages: { used: 410, total: 512 },
    })
    expect(value?.protocolMessages).toEqual({ used: 410, total: 512 })
  })

  test("reconciles manual compaction without pretending it is an exact model measurement", () => {
    const current = normalizeContextUsage({
      used: 80_000,
      total: 128_000,
      breakdown: { messages: 60_000, systemTools: 8_000, skills: 2_000, systemPrompt: 8_000, other: 2_000 },
      source: "model",
      updatedAt: 100,
    })
    const compacted = contextUsageAfterCompaction(current, 3_000, 200)!
    expect(compacted.used).toBe(23_000)
    expect(compacted.breakdown.messages).toBe(3_000)
    expect(compacted.total).toBe(128_000)
    expect(compacted.source).toBe("compaction-estimate")
    expect(compacted.estimated).toBe(true)
    expect(compacted.updatedAt).toBe(200)
  })
})
