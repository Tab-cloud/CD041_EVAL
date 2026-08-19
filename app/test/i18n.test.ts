import { describe, expect, test } from "bun:test"
import { translate } from "../src/i18n"
import { normalizeSystemSettings } from "../src/system-settings"

describe("application language", () => {
  test("defaults unsupported values to Simplified Chinese", () => {
    expect(normalizeSystemSettings({ language: "fr-FR" }).language).toBe("zh-CN")
  })

  test("keeps English as a supported persisted setting", () => {
    expect(normalizeSystemSettings({ language: "en-US" }).language).toBe("en-US")
  })

  test("translates labels and interpolates values", () => {
    expect(translate("zh-CN", "sidebar.workspace")).toBe("工作区")
    expect(translate("en-US", "sidebar.workspace")).toBe("Workspace")
    expect(translate("en-US", "topbar.reconnecting", { count: 3 })).toBe("Reconnecting (3)...")
  })
})

describe("application system settings", () => {
  test("preserves the complete backend execution budget contract", () => {
    const settings = normalizeSystemSettings({ executionBudget: {
      totalDurationMs: 4 * 60 * 60_000,
      rootWindowMs: 45 * 60_000,
      maxRootWindows: 5,
      childLeaseMs: 12 * 60_000,
      parentReserveMs: 7.5 * 60_000,
      minimumChildLeaseMs: 45_000,
      maxStagnantSegments: 6,
      maxRevisions: 9,
      maxRecoveryStrategies: 12,
    } })
    expect(settings.executionBudget).toEqual({
      totalDurationMs: 4 * 60 * 60_000,
      rootWindowMs: 45 * 60_000,
      maxRootWindows: 5,
      childLeaseMs: 12 * 60_000,
      parentReserveMs: 7.5 * 60_000,
      minimumChildLeaseMs: 45_000,
      maxStagnantSegments: 6,
      maxRevisions: 9,
      maxRecoveryStrategies: 12,
    })
  })
})
