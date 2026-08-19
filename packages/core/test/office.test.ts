import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractOfficeDocument } from "../src/util/office.ts"
import { readTool } from "../src/tool/fs/index.ts"
import { AttachmentProcessingError, processAttachments } from "../src/runtime/server-attachments.ts"
import { RAGEngine } from "../src/runtime/rag.ts"

const fixtures = join(import.meta.dir, "fixtures")
const legacyWord = join(fixtures, "legacy-word.doc")

function createGraphicalPdf(): Uint8Array {
  const stream = "0.1 0.6 0.2 rg 20 20 160 80 re f\n"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
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

describe("legacy Word document support", () => {
  test("extracts Word 97-2003 OLE content without external programs", async () => {
    const result = await extractOfficeDocument(readFileSync(legacyWord), "application/msword", 200_000, "legacy-word.doc")
    expect(result?.format).toBe("DOC")
    expect(result?.parser).toBe("word-extractor")
    expect(result?.text).toContain("This is a test of reviewing")
    expect(result?.text).toContain("😀")
  })

  test("read tool routes binary Word documents through the document extractor", async () => {
    const result = await readTool.execute({ paths: ["legacy-word.doc"] }, {
      workingDir: fixtures,
      sessionId: "office-test",
      agentId: "general",
    } as any)
    const content = (result.data as Record<string, string>)["legacy-word.doc"]
    expect(result.success).toBe(true)
    expect(content).toStartWith("[DOC]")
    expect(content).not.toContain("word-extractor")
    expect(content).toContain("This text has been inserted")
  })

  test("chat attachments and project indexing share the same DOC capability", async () => {
    const attachments = await processAttachments([{
      name: "legacy-word.doc",
      mime: "application/msword",
      kind: "binary",
      path: "Z:\\outside-workspace\\legacy-word.doc",
      dataBase64: readFileSync(legacyWord).toString("base64"),
    }], fixtures)
    expect(attachments[0]?.kind).toBe("text")
    expect(attachments[0]?.content).toContain("[DOC]")
    expect(attachments[0]?.content).not.toContain("word-extractor")

    const rag = new RAGEngine()
    await rag.indexProject(fixtures)
    expect(rag.search("reviewing", 3, fixtures).some((item) => item.source.endsWith("legacy-word.doc"))).toBe(true)
  })

  test("binary attachments fail at the transport boundary when bytes are missing", async () => {
    expect(processAttachments([{
      name: "legacy-word.doc",
      mime: "application/msword",
      kind: "binary",
      path: legacyWord,
    }], fixtures)).rejects.toBeInstanceOf(AttachmentProcessingError)
  })

  test("read recognizes PDF content and returns the domain-tool handoff without a generic size failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-pdf-read-"))
    try {
      writeFileSync(join(dir, "schematic.pdf"), createGraphicalPdf())
      const result = await readTool.execute({ paths: ["schematic.pdf"] }, {
        workingDir: dir, sessionId: "pdf-test", agentId: "hardware-engineer",
      } as any)
      expect(result.success).toBe(true)
      expect((result.data as Record<string, string>)["schematic.pdf"]).toContain("schematic_read")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
