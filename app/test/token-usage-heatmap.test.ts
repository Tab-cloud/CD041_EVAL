import { describe, expect, test } from "bun:test"
import {
  formatCompactTokens,
  heatmapSlots,
  normalizeTokenUsageHeatmap,
  tokenHeatLevel,
} from "../src/token-usage-heatmap"

const day = {
  date: "2026-07-28",
  promptTokens: 1_000,
  completionTokens: 250,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 300,
  totalTokens: 1_250,
  calls: 2,
  actualCalls: 1,
  estimatedCalls: 1,
}

describe("token heatmap projection", () => {
  test("normalizes the backend contract and rejects malformed counters", () => {
    expect(normalizeTokenUsageHeatmap({
      scope: "all",
      startDate: "2026-07-28",
      endDate: "2026-07-28",
      days: [day],
      totals: { ...day, date: undefined },
    })).toMatchObject({
      scope: "all",
      days: [day],
      totals: { totalTokens: 1_250, calls: 2 },
    })
    expect(normalizeTokenUsageHeatmap({
      scope: "all",
      startDate: "2026-07-28",
      endDate: "2026-07-28",
      days: [{ ...day, promptTokens: -1 }],
      totals: day,
    })).toBeNull()
  })

  test("uses logarithmic heat levels and Monday-aligned slots", () => {
    expect(tokenHeatLevel(0, 10_000)).toBe(0)
    expect(tokenHeatLevel(10_000, 10_000)).toBe(4)
    expect(heatmapSlots([day]).slice(0, 1)).toEqual([null])
    expect(heatmapSlots([day]).at(-1)).toEqual(day)
  })

  test("formats compact totals for the narrow sidebar", () => {
    expect(formatCompactTokens(980)).toBe("980")
    expect(formatCompactTokens(12_300)).toBe("12.3K")
    expect(formatCompactTokens(8_600_000)).toBe("8.6M")
  })
})
