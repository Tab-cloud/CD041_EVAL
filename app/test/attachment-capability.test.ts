import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("desktop attachment capability", () => {
  test("allows open-dialog files to be sized before they are read", () => {
    const capability = JSON.parse(readFileSync(
      join(import.meta.dir, "..", "src-tauri", "capabilities", "default.json"),
      "utf8",
    )) as { permissions?: Array<string | Record<string, unknown>> }
    const permissions = capability.permissions ?? []

    expect(permissions).toContain("dialog:default")
    expect(permissions).toContain("fs:allow-read-file")
    expect(permissions).toContain("fs:allow-stat")
  })
})
