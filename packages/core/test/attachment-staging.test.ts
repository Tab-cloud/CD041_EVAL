import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  processAttachments,
  stageUploadedAttachment,
} from "../src/runtime/server-attachments.ts"

describe("attachment staging", () => {
  test("processes a staged binary larger than the old request-body boundary", async () => {
    const workingDir = mkdtempSync(join(tmpdir(), "eval-staged-attachment-"))
    try {
      const bytes = new Uint8Array(12 * 1024 * 1024)
      bytes[0] = 0x41
      bytes[bytes.length - 1] = 0x5a
      const staged = await stageUploadedAttachment({
        name: "large.bin",
        mime: "application/octet-stream",
        kind: "binary",
        bytes,
      })
      const processed = await processAttachments([staged], workingDir)

      expect(staged.size).toBe(bytes.byteLength)
      expect(staged.uploadId).toMatch(/^[a-f0-9]{64}$/)
      expect(processed[0]?.content).toContain(`${bytes.byteLength} 字节`)
    } finally {
      rmSync(workingDir, { recursive: true, force: true })
    }
  })

  test("stages text-rich PDFs so page and layout tools retain the original document", async () => {
    const workingDir = mkdtempSync(join(tmpdir(), "eval-text-pdf-"))
    try {
      const content = `ESP32-S3 design introduction and reference. ${"Power and USB network evidence. ".repeat(20)}`
      const stream = `BT\n/F1 12 Tf\n20 80 Td\n(${content}) Tj\nET\n`
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ]
      let pdf = "%PDF-1.4\n"
      const offsets = [0]
      for (let index = 0; index < objects.length; index++) {
        offsets.push(Buffer.byteLength(pdf))
        pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
      }
      const xrefOffset = Buffer.byteLength(pdf)
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
      for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
      pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
      const bytes = new TextEncoder().encode(pdf)

      const staged = await stageUploadedAttachment({
        name: "design.pdf",
        mime: "application/pdf",
        kind: "binary",
        bytes,
      })
      const processed = await processAttachments([staged], workingDir)
      const stagedRelativePath = processed[0]?.content?.match(/\.eval[\\/]attachments[\\/][a-f0-9]{64}\.pdf/)?.[0]

      expect(processed[0]?.content).toContain("原始 PDF 已暂存")
      expect(stagedRelativePath).toBeTruthy()
      expect(existsSync(join(workingDir, stagedRelativePath!))).toBe(true)
    } finally {
      rmSync(workingDir, { recursive: true, force: true })
    }
  })

  test("rejects more than ten attachments instead of silently dropping them", async () => {
    const attachments = Array.from({ length: 11 }, (_, index) => ({
      name: `attachment-${index}.txt`,
      mime: "text/plain",
      kind: "text" as const,
      content: "content",
    }))

    await expect(processAttachments(attachments, process.cwd()))
      .rejects.toThrow("最多提交 10 个附件")
  })
})
