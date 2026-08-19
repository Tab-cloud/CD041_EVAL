import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const appRoot = resolve(import.meta.dir, "..")

describe("settings theme controls", () => {
  test("uses the themed number control for every Agent execution budget field", () => {
    const modal = readFileSync(resolve(appRoot, "src/components/SystemSettingsModal.tsx"), "utf8")
    const executionBudgetInputs = modal.match(/<input className="settings-number" type="number"/g) ?? []

    expect(executionBudgetInputs).toHaveLength(5)
  })

  test("renders number controls from theme variables with a visible focus state", () => {
    const styles = readFileSync(resolve(appRoot, "src/styles.css"), "utf8")
    const numberRule = styles.match(/\.settings-number\s*\{[\s\S]*?\}/)?.[0] ?? ""
    const focusRule = styles.match(/\.settings-number:focus\s*\{[\s\S]*?\}/)?.[0] ?? ""

    expect(numberRule).toContain("background: var(--bg-root)")
    expect(numberRule).toContain("color: var(--text-primary)")
    expect(numberRule).toContain("border: 1px solid var(--border-default)")
    expect(focusRule).toContain("border-color: var(--accent)")
    expect(focusRule).toContain("box-shadow: 0 0 0 2px var(--accent-dim)")
  })

  test("keeps save and close available when the current tab has no global changes", () => {
    const modal = readFileSync(resolve(appRoot, "src/components/SystemSettingsModal.tsx"), "utf8")

    expect(modal).toContain("if (!dirty) {")
    expect(modal).toContain("onClose()")
    expect(modal).toContain('disabled={saving}')
    expect(modal).not.toContain('disabled={saving || !dirty}')
    expect(modal).toContain('"保存并退出"')
    expect(modal).toContain('"Save and close"')
  })
})
