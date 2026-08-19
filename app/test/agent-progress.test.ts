import { describe, expect, test } from "bun:test"
import { normalizeAgentProgressBounds } from "../src/agent-progress"

describe("agent progress bounds", () => {
  test("never displays a current step greater than the advertised total", () => {
    expect(normalizeAgentProgressBounds(4, 1)).toEqual({ step: 4, maxSteps: 4 })
  })

  test("normalizes invalid and fractional progress values", () => {
    expect(normalizeAgentProgressBounds("bad", 0)).toEqual({ step: 1, maxSteps: 1 })
    expect(normalizeAgentProgressBounds(2.9, 3.9)).toEqual({ step: 2, maxSteps: 3 })
  })
})
