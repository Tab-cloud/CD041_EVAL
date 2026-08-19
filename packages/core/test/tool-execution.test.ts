import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildUnifiedDiff, captureFileSnapshot, restoreSnapshotIfUnchanged,
  ToolExecutionConflictError,
} from "../src/store/tool-execution"

describe("tool execution file history", () => {
  test("builds a line-level diff without marking unchanged lines as edits", () => {
    const result = buildUnifiedDiff("a\nb\nc", "a\nB\nc\nnew", "src/example.ts")

    expect(result.added).toBe(2)
    expect(result.removed).toBe(1)
    expect(result.diff).toContain("-b")
    expect(result.diff).toContain("+B")
    expect(result.diff).toContain(" c")
    expect(result.diff).not.toContain("-c")
  })

  test("restores an edited file when its current hash still matches", () => {
    withTempDir((dir) => {
      const path = join(dir, "source.txt")
      writeFileSync(path, "before\n", "utf8")
      const snapshot = captureFileSnapshot("edit", { path: "source.txt" }, dir)
      expect(snapshot).not.toBeNull()

      writeFileSync(path, "after\n", "utf8")
      restoreSnapshotIfUnchanged(snapshot!, hash("after\n"))
      expect(readFileSync(path, "utf8")).toBe("before\n")
    })
  })

  test("refuses to overwrite changes made after the tool execution", () => {
    withTempDir((dir) => {
      const path = join(dir, "source.txt")
      writeFileSync(path, "before", "utf8")
      const snapshot = captureFileSnapshot("write", { path: "source.txt", content: "agent" }, dir)!
      writeFileSync(path, "agent", "utf8")
      const afterHash = hash("agent")
      writeFileSync(path, "user change", "utf8")

      expect(() => restoreSnapshotIfUnchanged(snapshot, afterHash)).toThrow(ToolExecutionConflictError)
      expect(readFileSync(path, "utf8")).toBe("user change")
    })
  })

  test("removes a newly created file during undo", () => {
    withTempDir((dir) => {
      const path = join(dir, "created.txt")
      const snapshot = captureFileSnapshot("write", { path: "created.txt", content: "new" }, dir)!
      expect(snapshot.beforeExists).toBe(false)
      writeFileSync(path, "new", "utf8")

      restoreSnapshotIfUnchanged(snapshot, hash("new"))
      expect(existsSync(path)).toBe(false)
    })
  })

})

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eval-tool-execution-"))
  try { run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}
