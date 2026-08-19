import { describe, expect, test } from "bun:test"
import { createCanvas } from "@napi-rs/canvas"
import { cropImageDataUrl, extractPdfTextFromBuffer, locatePdfQuestionRegion, renderPdfPageDetailed } from "../src/util/pdf.ts"

function createSinglePagePdf(): Uint8Array {
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

function createPdfWithEmbeddedNulGlyph(): Uint8Array {
  const stream = "BT\n/F1 12 Tf\n20 80 Td\n(ABC\\000DEF) Tj\nET\n"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
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
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

describe("PDF rendering recovery", () => {
  test("text extraction does not detach the buffer needed by vision rendering", async () => {
    const pdf = createSinglePagePdf()
    const originalSize = pdf.byteLength

    await extractPdfTextFromBuffer(pdf)
    const rendered = await renderPdfPageDetailed(pdf, 1)

    expect(pdf.byteLength).toBe(originalSize)
    expect(rendered.renderer).toBe("pdfjs-canvas")
    expect(rendered.errors).toEqual([])
    expect(rendered.dataUrl?.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("sanitizes embedded NUL glyphs before the native Canvas text boundary", async () => {
    const rendered = await renderPdfPageDetailed(createPdfWithEmbeddedNulGlyph(), 1)

    expect(rendered.renderer).toBe("pdfjs-canvas")
    expect(rendered.errors).toEqual([])
    expect(rendered.dataUrl?.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("locates question labels and crops a bounded high-resolution evidence region", async () => {
    const region = locatePdfQuestionRegion({
      pageWidth: 1000,
      pageHeight: 800,
      items: [
        { text: "PB6", x: 0.44, y: 0.42, width: 0.03, height: 0.02 },
        { text: "UART_RXD", x: 0.50, y: 0.42, width: 0.08, height: 0.02 },
        { text: "UNRELATED", x: 0.90, y: 0.90, width: 0.05, height: 0.02 },
      ],
    }, "PB6 是否连接 UART_RXD？")
    expect(region).not.toBeNull()
    expect(region!.matchedText).toEqual(["PB6", "UART_RXD"])
    expect(region!.width * region!.height).toBeLessThan(0.4)

    const page = createCanvas(1000, 800)
    page.getContext("2d").fillRect(0, 0, 1000, 800)
    const cropped = await cropImageDataUrl(page.toDataURL("image/png"), region!)
    expect(cropped.startsWith("data:image/png;base64,")).toBe(true)
    expect(cropped.length).toBeGreaterThan(100)
  })
})
