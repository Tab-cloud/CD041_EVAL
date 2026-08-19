/**
 * 办公文档提取：DOC / DOCX / XLSX / PPTX → 纯文本
 *
 * - DOC: word-extractor（OLE Compound File，纯 JS）
 * - DOCX: mammoth → Markdown
 * - XLSX: jszip + XML → CSV-like text
 * - PPTX: jszip + XML → slide text
 */
import * as mammoth from "mammoth"
import JSZip from "jszip"
import WordExtractor from "word-extractor"
import { extname } from "node:path"

export interface DocExtractResult {
  text: string
  truncated: boolean
  pages?: number   // PPTX: slides count; XLSX: sheet count
  format: "DOC" | "DOCX" | "XLSX" | "PPTX"
  parser: "word-extractor" | "mammoth" | "ooxml"
}

const OFFICE_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
])

const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".xlsx", ".pptx"])

export function isOfficeDocument(name: string, mime = ""): boolean {
  return OFFICE_MIMES.has(mime.toLowerCase()) || OFFICE_EXTENSIONS.has(extname(name).toLowerCase())
}

/** Word 97-2003 OLE DOC → structured plain text. */
export async function extractLegacyDoc(buffer: Uint8Array, maxChars = 200_000): Promise<DocExtractResult> {
  if (!hasOleSignature(buffer)) throw new Error("文件不是有效的 Word 97-2003 OLE 文档")
  const extractor = new WordExtractor()
  const document = await extractor.extract(Buffer.from(buffer))
  const sections = [
    ["", document.getBody({ filterUnicode: false })],
    ["页眉", document.getHeaders({ filterUnicode: false, includeFooters: false })],
    ["页脚", document.getFooters({ filterUnicode: false })],
    ["脚注", document.getFootnotes({ filterUnicode: false })],
    ["尾注", document.getEndnotes({ filterUnicode: false })],
    ["批注", document.getAnnotations({ filterUnicode: false })],
    ["文本框", document.getTextboxes({ filterUnicode: false })],
  ] as const
  const text = sections
    .map(([label, value]) => {
      const normalized = normalizeWordText(value)
      return normalized ? `${label ? `## ${label}\n` : ""}${normalized}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
  if (!text.trim()) throw new Error("Word 文档未包含可提取的文本，可能已加密、损坏或仅包含图片")
  return truncateOfficeText(text, maxChars, "DOC", "word-extractor")
}

/** DOCX → Markdown */
export async function extractDocx(buffer: Uint8Array, maxChars = 200_000): Promise<DocExtractResult> {
  const result = await (mammoth as any).convertToMarkdown(
    { buffer: buffer as any },
    { styleMap: ["p[style-name='Heading 1'] => # ", "p[style-name='Heading 2'] => ## "] },
  )
  const text = result.value
  const truncated = text.length > maxChars
  return {
    text: truncated ? text.slice(0, maxChars) + "\n\n[…DOCX 已截断…]" : text,
    truncated,
    format: "DOCX",
    parser: "mammoth",
  }
}

/** XLSX → CSV-like text（每行 = 单元格值，逗号分隔） */
export async function extractXlsx(buffer: Uint8Array, maxChars = 200_000): Promise<DocExtractResult> {
  const zip = await JSZip.loadAsync(buffer)
  // 读取 shared strings
  let sharedStrings: string[] = []
  const ssFile = zip.file("xl/sharedStrings.xml")
  if (ssFile) {
    const ssXml = await ssFile.async("text")
    const matches = ssXml.match(/<t[^>]*>([\s\S]*?)<\/t>/g)
    if (matches) {
      sharedStrings = matches.map(m => {
        const inner = m.replace(/<t[^>]*>/, "").replace(/<\/t>/, "")
        return inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
      })
    }
  }

  // 找所有 sheet
  const sheets = Object.keys(zip.files).filter(f => /xl\/worksheets\/sheet\d+\.xml/i.test(f)).sort()
  if (sheets.length === 0) sheets.push("xl/worksheets/sheet1.xml")

  const allRows: string[] = []
  for (const sheetFile of sheets) {
    const xml = await zip.file(sheetFile)?.async("text")
    if (!xml) continue
    // 解析 <row> 中的 <c> 单元格
    const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g
    let rowMatch
    while ((rowMatch = rowRegex.exec(xml)) !== null) {
      const cells: string[] = []
      const cellRegex = /<c[^>]*>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>/g
      let cellMatch
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        const idx = parseInt(cellMatch[1])
        cells.push(sharedStrings[idx] ?? cellMatch[1])
      }
      if (cells.length > 0) allRows.push(cells.join("\t"))
    }
  }

  const text = allRows.join("\n")
  const truncated = text.length > maxChars
  return {
    text: truncated ? text.slice(0, maxChars) + "\n\n[…XLSX 已截断…]" : text,
    truncated,
    pages: sheets.length,
    format: "XLSX",
    parser: "ooxml",
  }
}

/** PPTX → 每页幻灯片文本 */
export async function extractPptx(buffer: Uint8Array, maxChars = 200_000): Promise<DocExtractResult> {
  const zip = await JSZip.loadAsync(buffer)
  // 找所有 slide
  const slides = Object.keys(zip.files)
    .filter(f => /ppt\/slides\/slide\d+\.xml/i.test(f))
    .sort((a, b) => {
      const an = parseInt(a.match(/slide(\d+)/i)?.[1] ?? "0")
      const bn = parseInt(b.match(/slide(\d+)/i)?.[1] ?? "0")
      return an - bn
    })

  const slideTexts: string[] = []
  for (const slideFile of slides) {
    const xml = await zip.file(slideFile)?.async("text")
    if (!xml) continue
    // 提取所有 <a:t> 标签内容
    const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)
    const lines: string[] = []
    if (matches) {
      for (const m of matches) {
        const text = m.replace(/<a:t[^>]*>/, "").replace(/<\/a:t>/, "").trim()
        if (text) lines.push(text)
      }
    }
    if (lines.length > 0) {
      const slideNum = parseInt(slideFile.match(/slide(\d+)/i)?.[1] ?? "0")
      slideTexts.push(`--- Slide ${slideNum} ---\n${lines.join("\n")}`)
    }
  }

  const text = slideTexts.join("\n\n")
  const truncated = text.length > maxChars
  return {
    text: truncated ? text.slice(0, maxChars) + "\n\n[…PPTX 已截断…]" : text,
    truncated,
    pages: slides.length,
    format: "PPTX",
    parser: "ooxml",
  }
}

/** 路由：根据 mime 调用对应提取器 */
export async function extractOfficeDocument(
  buffer: Uint8Array,
  mime: string,
  maxChars = 200_000,
  fileName = "",
): Promise<DocExtractResult | null> {
  const extension = extname(fileName).toLowerCase()
  if (mime === "application/msword" || extension === ".doc" || hasOleSignature(buffer)) {
    return extractLegacyDoc(buffer, maxChars)
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extractDocx(buffer, maxChars)
  }
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return extractXlsx(buffer, maxChars)
  }
  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return extractPptx(buffer, maxChars)
  }
  if (extension === ".docx") return extractDocx(buffer, maxChars)
  if (extension === ".xlsx") return extractXlsx(buffer, maxChars)
  if (extension === ".pptx") return extractPptx(buffer, maxChars)
  return null
}

function hasOleSignature(buffer: Uint8Array): boolean {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  return buffer.length >= signature.length && signature.every((value, index) => buffer[index] === value)
}

function normalizeWordText(value: string): string {
  return Array.from(value
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n\n--- Page Break ---\n\n")
  )
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || (code >= 32 && code !== 127)
    })
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
}

function truncateOfficeText(
  text: string,
  maxChars: number,
  format: DocExtractResult["format"],
  parser: DocExtractResult["parser"],
): DocExtractResult {
  const truncated = text.length > maxChars
  return {
    text: truncated ? `${text.slice(0, maxChars)}\n\n[…${format} 已截断…]` : text,
    truncated,
    format,
    parser,
  }
}
