import { describe, expect, test } from "bun:test"
import {
  formatDeliveredFileSize,
  normalizeDeliveredFiles,
} from "../src/delivered-files"

describe("delivered files", () => {
  test("normalizes valid server records and de-duplicates paths", () => {
    const files = normalizeDeliveredFiles([
      {
        artifactId: "old",
        name: "report.pdf",
        path: "C:\\workspace\\report.pdf",
        relativePath: "report.pdf",
        extension: "PDF",
        category: "pdf",
        size: 1024,
        exists: true,
        stale: false,
        updatedAt: 1,
      },
      {
        artifactId: "new",
        name: "report.pdf",
        path: "C:\\workspace\\report.pdf",
        relativePath: "report.pdf",
        extension: "pdf",
        category: "pdf",
        size: 2048,
        exists: true,
        stale: true,
        updatedAt: 2,
      },
      { name: "", path: "" },
    ])

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      artifactId: "new",
      extension: "pdf",
      size: 2048,
      stale: true,
    })
  })

  test("rejects malformed payloads and formats file sizes", () => {
    expect(normalizeDeliveredFiles(null)).toEqual([])
    expect(normalizeDeliveredFiles([{ name: "missing path" }])).toEqual([])
    expect(formatDeliveredFileSize(512)).toBe("512 B")
    expect(formatDeliveredFileSize(1536)).toBe("1.5 KB")
    expect(formatDeliveredFileSize(2 * 1024 * 1024)).toBe("2 MB")
  })
})
