import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DocumentIngestionError,
  DocumentIngestionPipeline,
  PdfDocumentExtractor,
  documentIngestionPipeline,
} from "../src/util/document-ingestion.ts"
import { readTool } from "../src/tool/fs/index.ts"
import { ocrImageTool } from "../src/tool/hardware/ocr.ts"

function createTextPdf(text: string): Uint8Array {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
  const stream = `BT\n/F1 12 Tf\n20 80 Td\n(${escaped}) Tj\nET\n`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
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
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

describe("document ingestion architecture", () => {
  test("PDF adapters expose normalized local extraction metadata", async () => {
    const result = await documentIngestionPipeline.ingest({
      name: "r818-datasheet.pdf",
      mime: "application/pdf",
      bytes: createTextPdf("R818 Cortex-A7 DDR display multimedia datasheet introduction"),
    })
    expect(result).toMatchObject({
      format: "PDF",
      parser: "unpdf",
      pages: 1,
      truncated: false,
      graphical: false,
    })
    expect(result.text).toContain("R818 Cortex-A7")
  })

  test("the adapter registry fails with a typed unsupported-document error", async () => {
    const pipeline = new DocumentIngestionPipeline([new PdfDocumentExtractor()])
    await expect(pipeline.ingest({
      name: "firmware.bin",
      mime: "application/octet-stream",
      bytes: new Uint8Array([1, 2, 3]),
    })).rejects.toMatchObject<DocumentIngestionError>({ code: "unsupported-document" })
  })

  test("generic read provides text-PDF redundancy without invoking OCR", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-document-read-"))
    try {
      const fileName = "r818.pdf"
      await writeFile(join(root, fileName), createTextPdf("R818 CPU Cortex-A7 memory display peripheral boot"))
      const result = await readTool.execute({ paths: [fileName] }, {
        sessionId: "document-read",
        agentId: "main-agent",
        workingDir: root,
      })
      expect(result.success).toBe(true)
      expect(JSON.stringify(result.data)).toContain("R818 CPU Cortex-A7")
      expect(JSON.stringify(result.data)).not.toContain("read 不把图形 PDF")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("OCR rejects PDF by magic bytes and routes recovery to document tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-ocr-media-"))
    try {
      const fileName = "manual.dat"
      await writeFile(join(root, fileName), createTextPdf("R818 datasheet"))
      const result = await ocrImageTool.execute({ path: fileName }, {
        sessionId: "ocr-media",
        agentId: "main-agent",
        workingDir: root,
      })
      expect(result.success).toBe(false)
      expect(result.outcome?.diagnostic?.kind).toBe("unsupported-media-type")
      expect(result.outcome?.diagnostic?.recoveryCandidates?.[0]?.steps[0]?.tools)
        .toEqual(["datasheet_read", "schematic_read"])
      expect(result.error).toContain("当前输入是 PDF")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
