import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const workspaceRoot = resolve(import.meta.dir, "../../..")

describe("package manager configuration", () => {
  test("keeps pnpm 11 settings in the workspace config and never installs implicitly before scripts", () => {
    const manifest = JSON.parse(readFileSync(resolve(workspaceRoot, "package.json"), "utf8")) as {
      packageManager?: string
      pnpm?: unknown
    }
    const workspace = readFileSync(resolve(workspaceRoot, "pnpm-workspace.yaml"), "utf8")

    expect(manifest.packageManager).toMatch(/^pnpm@11\./)
    expect(manifest.pnpm).toBeUndefined()
    expect(workspace).toContain("verifyDepsBeforeRun: error")
    expect(workspace).toContain("enableGlobalVirtualStore: false")
    expect(workspace).toMatch(/overrides:\s*\r?\n\s+lodash: ['\"]?4\.18\.1['\"]?/)
    expect(workspace).toContain("onlyBuiltDependencies:")
  })
})
