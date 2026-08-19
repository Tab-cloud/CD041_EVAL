/**
 * PDF 处理（基于 unpdf / pdfjs-dist）：
 * - 文本提取：datasheet / 手册 → 纯文本
 * - 页面渲染：原理图 / 电路图 → 页面图片 → 视觉模型（多级渲染回退）
 */
import { extractText, getDocumentProxy } from "unpdf"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** 惰性加载 sharp（原生模块，bun build --compile 可能无法打包） */
let _sharp: typeof import("sharp")["default"] | null | undefined = undefined
async function getSharp(): Promise<typeof import("sharp")["default"] | null> {
  if (_sharp !== undefined) return _sharp
  try {
    const mod = await import("sharp")
    _sharp = mod.default
    return _sharp
  } catch {
    _sharp = null
    return null
  }
}

export interface PdfExtractResult {
  text: string
  pages: number
  truncated: boolean
}

export interface PdfTextPosition {
  text: string
  /** Coordinates normalized to the rendered page, with the origin at top-left. */
  x: number
  y: number
  width: number
  height: number
}

export interface PdfTextLayout {
  pageWidth: number
  pageHeight: number
  items: PdfTextPosition[]
}

export interface PdfNormalizedRegion {
  x: number
  y: number
  width: number
  height: number
  matchedText: string[]
}

/** 从 Uint8Array 提取 PDF 文本 */
export async function extractPdfTextFromBuffer(
  buffer: Uint8Array,
  options: { maxChars?: number } = {},
): Promise<PdfExtractResult> {
  const maxChars = options.maxChars ?? 200_000
  const result = await extractText(copyPdfBuffer(buffer), { mergePages: true })
  const text = (result.text as string | string[]) ?? ""
  const fullText = Array.isArray(text) ? text.join("\n") : text
  const truncated = fullText.length > maxChars
  return {
    text: truncated ? fullText.slice(0, maxChars) + "\n\n[…PDF 已截断…]" : fullText,
    pages: result.totalPages ?? 0,
    truncated,
  }
}

/** 从文件路径提取 */
export async function extractPdfTextFromPath(
  path: string,
  options: { maxChars?: number } = {},
): Promise<PdfExtractResult> {
  const file = Bun.file(path)
  const buffer = new Uint8Array(await file.arrayBuffer())
  return extractPdfTextFromBuffer(buffer, options)
}

/** 提取指定的 1-indexed PDF 页面文本。 */
export async function extractPdfPageText(
  buffer: Uint8Array,
  pageNumber: number,
  maxChars = 50_000,
): Promise<{ text: string; pages: number; truncated: boolean }> {
  const pdf = await getDocumentProxy(copyPdfBuffer(buffer) as any)
  try {
    const pages = (pdf as any).numPages as number
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pages) {
      throw new Error(`PDF 页码超出范围: ${pageNumber}（共 ${pages} 页）`)
    }
    const page = await (pdf as any).getPage(pageNumber)
    const content = await page.getTextContent()
    const fullText = (content.items as Array<{ str?: string }>).map((item) => item.str ?? "").join(" ")
    const truncated = fullText.length > maxChars
    return { text: truncated ? fullText.slice(0, maxChars) : fullText, pages, truncated }
  } finally {
    await (pdf as any).destroy()
  }
}

/** Extract positioned text without discarding the PDF text transform. */
export async function extractPdfPageTextLayout(buffer: Uint8Array, pageNumber: number): Promise<PdfTextLayout> {
  const pdf = await getDocumentProxy(copyPdfBuffer(buffer) as any)
  try {
    const pages = Number((pdf as any).numPages)
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pages) {
      throw new Error(`PDF 页码超出范围: ${pageNumber}（共 ${pages} 页）`)
    }
    const page = await (pdf as any).getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items: PdfTextPosition[] = []
    for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
      const text = raw.str?.trim()
      const transform = raw.transform
      if (!text || !transform || transform.length < 6) continue
      const [screenX, screenY] = viewport.convertToViewportPoint(transform[4], transform[5])
      const width = Math.max(Number(raw.width) || 1, 1)
      const height = Math.max(Number(raw.height) || Math.hypot(transform[2], transform[3]) || 1, 1)
      items.push({
        text,
        x: clamp01(screenX / viewport.width),
        y: clamp01((screenY - height) / viewport.height),
        width: clamp01(width / viewport.width),
        height: clamp01(height / viewport.height),
      })
    }
    return { pageWidth: viewport.width, pageHeight: viewport.height, items }
  } finally {
    await (pdf as any).destroy()
  }
}

/** Locate a bounded region around labels explicitly mentioned by the question. */
export function locatePdfQuestionRegion(layout: PdfTextLayout, question: string): PdfNormalizedRegion | null {
  const tokens = [...new Set(question.match(/[A-Za-z][A-Za-z0-9_+./-]{1,31}|\b\d{1,3}\b/g)?.map((token) => token.toLowerCase()) ?? [])]
    .filter((token) => !new Set(["pdf", "mcu", "pin"]).has(token))
  if (tokens.length === 0) return null
  const matches = layout.items.filter((item) => {
    const value = item.text.toLowerCase()
    return tokens.some((token) => pdfLabelMatchesToken(value, token))
  })
  if (matches.length === 0) return null
  // Repeated net labels can occur across the whole sheet. Build a local
  // neighborhood around every hit and choose the smallest cluster covering
  // the most distinct query tokens instead of unioning unrelated occurrences.
  const clusters = matches.map((anchor) => {
    const anchorX = anchor.x + anchor.width / 2
    const anchorY = anchor.y + anchor.height / 2
    const items = matches.filter((item) => {
      const centerX = item.x + item.width / 2
      const centerY = item.y + item.height / 2
      return Math.abs(centerX - anchorX) <= 0.28 && Math.abs(centerY - anchorY) <= 0.22
    })
    const coveredTokens = new Set(tokens.filter((token) => items.some((item) => {
      const value = item.text.toLowerCase()
      return pdfLabelMatchesToken(value, token)
    })))
    const minX = Math.min(...items.map((item) => item.x))
    const minY = Math.min(...items.map((item) => item.y))
    const maxX = Math.max(...items.map((item) => item.x + item.width))
    const maxY = Math.max(...items.map((item) => item.y + item.height))
    return { items, coveredTokens: coveredTokens.size, area: (maxX - minX) * (maxY - minY), minX, minY, maxX, maxY }
  })
  clusters.sort((left, right) => right.coveredTokens - left.coveredTokens || right.items.length - left.items.length || left.area - right.area)
  const selected = clusters[0]
  const { minX, minY, maxX, maxY } = selected
  const x = clamp01(minX - 0.12)
  const y = clamp01(minY - 0.15)
  const right = clamp01(maxX + 0.12)
  const bottom = clamp01(maxY + 0.15)
  // A nearly full-page crop provides no independent spatial evidence.
  if ((right - x) * (bottom - y) > 0.72) return null
  return { x, y, width: right - x, height: bottom - y, matchedText: selected.items.slice(0, 40).map((item) => item.text) }
}

function pdfLabelMatchesToken(label: string, token: string): boolean {
  return label === token || label.includes(token) || (label.length >= 3 && token.includes(label))
}

/** Crop an already-rendered page using normalized PDF coordinates. */
export async function cropImageDataUrl(dataUrl: string, region: PdfNormalizedRegion): Promise<string> {
  const canvasModule = await import("@napi-rs/canvas")
  const encoded = dataUrl.replace(/^data:image\/[A-Za-z0-9.+-]+;base64,/, "")
  const image = await canvasModule.loadImage(Buffer.from(encoded, "base64"))
  const sx = Math.max(0, Math.floor(region.x * image.width))
  const sy = Math.max(0, Math.floor(region.y * image.height))
  const sw = Math.max(1, Math.min(image.width - sx, Math.ceil(region.width * image.width)))
  const sh = Math.max(1, Math.min(image.height - sy, Math.ceil(region.height * image.height)))
  const canvas = canvasModule.createCanvas(sw, sh)
  canvas.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvas.toDataURL("image/png")
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** 文档代理方式（更大 PDF） */
export async function extractPdfTextViaProxy(
  buffer: Uint8Array,
  options: { maxChars?: number } = {},
): Promise<PdfExtractResult> {
  const maxChars = options.maxChars ?? 200_000
  const pdf = await getDocumentProxy(copyPdfBuffer(buffer) as any)
  const { text, totalPages } = await (pdf as any).getText()
  const fullText = Array.isArray(text) ? text.join("\n") : (text as string)
  const truncated = fullText.length > maxChars
  pdf.destroy()
  return {
    text: truncated ? fullText.slice(0, maxChars) + "\n\n[…PDF 已截断…]" : fullText,
    pages: totalPages ?? 0,
    truncated,
  }
}

/**
 * 渲染 PDF 首页为 dataUrl（供视觉模型直接用）
 *
 * 优先级：
 * 1. sharp (libvips) → 直接渲染 PDF 首页为 PNG（推荐，无需 canvas）
 * 2. unpdf 文本回退 → 返回 null 告知调用方使用文本分析
 */
export interface PdfRenderResult {
  dataUrl: string | null
  renderer?: "pdfjs-canvas" | "sharp" | "pdftoppm" | "mutool" | "imagemagick" | "python-pymupdf"
  errors: string[]
}

export async function renderPdfFirstPage(buffer: Uint8Array): Promise<string | null> {
  return (await renderPdfPageDetailed(buffer, 1)).dataUrl
}

/** 多级 PDF 页面渲染；每一级失败后继续尝试，不因单一工具缺失而放弃视觉识别。 */
export async function renderPdfPageDetailed(buffer: Uint8Array, pageNumber: number): Promise<PdfRenderResult> {
  const errors: string[] = []
  try {
    const dataUrl = await renderPdfWithCanvas(buffer, pageNumber)
    if (dataUrl.startsWith("data:image/")) return { dataUrl, renderer: "pdfjs-canvas", errors }
  } catch (error) {
    errors.push(`PDF.js Canvas: ${errorMessage(error)}`)
  }

  // Sharp 的 Windows libvips 通常没有 PDF 支持，但在支持 poppler 的环境仍可使用。
  const sharp = await getSharp()
  if (sharp) {
    try {
      const pngBuffer = await sharp(buffer, { page: pageNumber - 1, density: 180 })
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .png({ quality: 90 })
        .toBuffer()
      const b64 = Buffer.from(pngBuffer).toString("base64")
      return { dataUrl: `data:image/png;base64,${b64}`, renderer: "sharp", errors }
    } catch (error) {
      errors.push(`Sharp: ${errorMessage(error)}`)
    }
  } else {
    errors.push("Sharp: 模块不可用")
  }

  const external = await renderPdfWithExternalTools(buffer, pageNumber, errors)
  if (external) return external
  return { dataUrl: null, errors }
}

/** 渲染指定的 1-indexed PDF 页面。 */
export async function renderPdfPage(buffer: Uint8Array, pageNumber: number): Promise<string | null> {
  return (await renderPdfPageDetailed(buffer, pageNumber)).dataUrl
}

/**
 * 渲染 PDF 指定页数为 dataUrl 数组（供多页分析）
 */
export async function renderPdfPages(buffer: Uint8Array, pages: number[]): Promise<string[]> {
  const results: string[] = []
  for (const page of pages) {
    const rendered = await renderPdfPageDetailed(buffer, page + 1)
    if (rendered.dataUrl) results.push(rendered.dataUrl)
  }
  return results
}

async function renderPdfWithExternalTools(buffer: Uint8Array, pageNumber: number, errors: string[]): Promise<PdfRenderResult | null> {
  const directory = await mkdtemp(join(tmpdir(), "eval-pdf-render-"))
  const input = join(directory, "input.pdf")
  const output = join(directory, "page.png")
  await writeFile(input, buffer)
  try {
    const attempts: Array<{ renderer: NonNullable<PdfRenderResult["renderer"]>; command: string[]; outputPath: string }> = [
      { renderer: "pdftoppm", command: ["pdftoppm", "-f", String(pageNumber), "-singlefile", "-png", "-r", "180", input, join(directory, "page")], outputPath: output },
      { renderer: "mutool", command: ["mutool", "draw", "-F", "png", "-r", "180", "-o", output, input, String(pageNumber)], outputPath: output },
      { renderer: "imagemagick", command: ["magick", "-density", "180", `${input}[${pageNumber - 1}]`, "-resize", "2048x2048>", output], outputPath: output },
    ]
    for (const attempt of attempts) {
      const failure = await runConverter(attempt.command)
      if (!failure) {
        const dataUrl = await fileToDataUrl(attempt.outputPath).catch(() => null)
        if (dataUrl) return { dataUrl, renderer: attempt.renderer, errors }
      }
      errors.push(`${attempt.renderer}: ${failure ?? "未生成图片"}`)
    }

    const pythonScript = join(directory, "render_pdf.py")
    await writeFile(pythonScript, [
      "import sys",
      "import fitz",
      "",
      "document = fitz.open(sys.argv[1])",
      "page = document.load_page(int(sys.argv[3]) - 1)",
      "zoom = max(1.5, min(3.0, 3072.0 / max(page.rect.width, page.rect.height)))",
      "pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)",
      "pixmap.save(sys.argv[2])",
      "document.close()",
      "",
    ].join("\n"))
    const pythonCommands = process.platform === "win32"
      ? [["python", pythonScript, input, output, String(pageNumber)], ["py", "-3", pythonScript, input, output, String(pageNumber)]]
      : [["python3", pythonScript, input, output, String(pageNumber)], ["python", pythonScript, input, output, String(pageNumber)]]
    for (const command of pythonCommands) {
      const failure = await runConverter(command)
      if (!failure) {
        const dataUrl = await fileToDataUrl(output).catch(() => null)
        if (dataUrl) return { dataUrl, renderer: "python-pymupdf", errors }
      }
      errors.push(`Python/PyMuPDF (${command[0]}): ${failure ?? "未生成图片"}`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
  return null
}

/**
 * 直接让 PDF.js 页面渲染到 napi Canvas。
 *
 * 不使用 unpdf.renderPageAsImage：它会把 CanvasFactory 类传给 PDF.js，
 * Bun 单文件编译后该类可能进入 worker 的结构化克隆路径并失败。
 */
async function renderPdfWithCanvas(buffer: Uint8Array, pageNumber: number): Promise<string> {
  const canvasModule = await import("@napi-rs/canvas")
  if (typeof globalThis.DOMMatrix === "undefined") {
    Object.assign(globalThis, { DOMMatrix: canvasModule.DOMMatrix })
  }
  if (typeof globalThis.ImageData === "undefined") {
    Object.assign(globalThis, { ImageData: canvasModule.ImageData })
  }
  if (typeof globalThis.Path2D === "undefined") {
    Object.assign(globalThis, { Path2D: canvasModule.Path2D })
  }

  // 使用独立 ArrayBuffer，避免 Bun.file 的底层缓冲区被 PDF.js 转移后影响后续回退。
  const pdfData = copyPdfBuffer(buffer)
  const pdf = await getDocumentProxy(pdfData as any)
  try {
    const totalPages = Number((pdf as any).numPages)
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
      throw new Error(`PDF 页码超出范围: ${pageNumber}（共 ${totalPages} 页）`)
    }
    const page = await (pdf as any).getPage(pageNumber)
    const baseViewport = page.getViewport({ scale: 1 })
    const longestSide = Math.max(baseViewport.width, baseViewport.height)
    const scale = Math.max(1.5, Math.min(3, 3072 / longestSide))
    const viewport = page.getViewport({ scale })
    const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext("2d")
    guardCanvasText(context)
    await page.render({ canvas, canvasContext: context, viewport }).promise
    return canvas.toDataURL("image/png")
  } finally {
    await (pdf as any).destroy()
  }
}

/**
 * Some engineering PDFs contain embedded NUL glyphs. PDF.js forwards those
 * glyph strings to Canvas, while @napi-rs/canvas rejects them at the native
 * CString boundary. Keep the page render alive and preserve the glyph position
 * by replacing only the invalid NUL code point.
 */
function guardCanvasText(context: any): void {
  const wrap = (method: "fillText" | "strokeText") => {
    const original = context[method].bind(context)
    context[method] = (text: unknown, ...args: unknown[]) =>
      original(String(text).split("\u0000").join("\uFFFD"), ...args)
  }
  wrap("fillText")
  wrap("strokeText")
}

/** PDF.js 会转移输入的 ArrayBuffer；每次调用必须持有自己的副本。 */
function copyPdfBuffer(buffer: Uint8Array): Uint8Array {
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy
}

async function runConverter(command: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "pipe", windowsHide: true })
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    return exitCode === 0 ? null : (stderr.trim().slice(0, 300) || `退出码 ${exitCode}`)
  } catch (error) {
    return errorMessage(error)
  }
}

async function fileToDataUrl(path: string): Promise<string> {
  const content = await readFile(path)
  if (content.length === 0) throw new Error("转换结果为空")
  return `data:image/png;base64,${content.toString("base64")}`
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

/** 检查 PDF 是否为图形为主的文档（内容文字很少 → 可能是原理图） */
export function isGraphicalPdf(text: string): boolean {
  // 文字 < 200 字符且不含常见文档关键词 = 可能为图表
  if (text.length < 200 && !/(introduction|概述|datasheet|数据手册|abstract|reference|参考|table of contents|目录)/i.test(text)) {
    return true
  }
  return false
}
