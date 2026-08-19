import { defineTool } from "../define"
import { safePath } from "../helpers"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import type { Worker } from "tesseract.js"

const IMAGE_MIME_BY_MAGIC: Array<{ magic: readonly number[]; mime: string }> = [
  { magic: [0x89, 0x50, 0x4E, 0x47], mime: "image/png" },
  { magic: [0xFF, 0xD8, 0xFF], mime: "image/jpeg" },
  { magic: [0x42, 0x4D], mime: "image/bmp" },
]

// ── tesseract.js 懒加载 ──
let _tesseractWorker: Worker | null = null
async function tessOcr(imagePath: string): Promise<string | null> {
  const { createWorker } = await import("tesseract.js")
  if (!_tesseractWorker) _tesseractWorker = await createWorker("eng+chi_sim")
  const fs = await import("node:fs")
  const raw = fs.readFileSync(imagePath)
  const b64 = raw.toString("base64")
  const mime = sniffOcrInputMime(new Uint8Array(raw)) ?? "image/png"
  const result = await _tesseractWorker.recognize(`data:${mime};base64,${b64}`)
  return result.data.text?.trim() || null
}

// ── 外部 OCR CLI 引擎路径检测 ──
function findExternalOcr(): string | null {
  // 与 eval-server 同目录查找
  const exeDir = process.argv0 ? resolve(process.argv0, "..") : process.cwd()
  const candidates = [
    resolve(exeDir, "ocr-engine.exe"),      // 用户可放这里
    resolve(exeDir, "RapidOCR-json.exe"),
    resolve(process.cwd(), "ocr-engine.exe"),
    resolve(process.cwd(), "RapidOCR-json.exe"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

async function externalOcr(imagePath: string, enginePath: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const proc = spawnSync(enginePath, ["--image_path=" + imagePath], {
      timeout: 30000,
      encoding: "utf-8",
      windowsHide: true,
    })
    if (proc.error || proc.status !== 0) { resolvePromise(null); return }
    try {
      const data = JSON.parse(proc.stdout || "{}")
      // RapidOCR-json 格式: [{text, confidence, box}]
      if (Array.isArray(data)) {
        const text = data.map((b: any) => b.text || "").join("\n").trim()
        resolvePromise(text || null)
      } else {
        resolvePromise(data.text || data.result || null)
      }
    } catch {
      // 非 JSON 输出，直接当文本
      resolvePromise((proc.stdout || "").trim() || null)
    }
  })
}

export const ocrImageTool = defineTool({
  name: "ocr_image",
  description: "对图片进行 OCR 文字识别（支持中英文）。返回图片中的文字内容。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "图片文件的绝对路径（PNG/JPEG/BMP）" },
    },
    required: ["path"],
  },
  async execute({ path }: { path: string }, ctx: any) {
    // 收容图片路径到工作目录，防止越权读
    let imgPath: string
    try {
      imgPath = safePath(ctx.workingDir, path)
    } catch {
      return { success: false, error: `路径越权: ${path}` }
    }
    const fs = await import("node:fs")
    if (!fs.existsSync(imgPath)) return { success: false, error: `文件不存在: ${imgPath}` }
    const raw = new Uint8Array(fs.readFileSync(imgPath))
    const mime = sniffOcrInputMime(raw)
    if (!mime) {
      const isPdf = raw.byteLength >= 4
        && raw[0] === 0x25 && raw[1] === 0x50 && raw[2] === 0x44 && raw[3] === 0x46
      const summary = isPdf
        ? "ocr_image 只接收图片，当前输入是 PDF；数据手册请使用 datasheet_read，原理图请使用 schematic_read"
        : "ocr_image 只支持 PNG、JPEG、BMP 图片，当前文件类型不受支持"
      return {
        success: false,
        error: summary,
        outcome: {
          status: "failed",
          category: "generic",
          summary,
          fingerprint: `unsupported-ocr-media:${isPdf ? "pdf" : "unknown"}`,
          diagnostic: {
            kind: "unsupported-media-type",
            evidence: [`检测到的输入类型: ${isPdf ? "application/pdf" : "unknown"}`],
            nextActions: [isPdf ? "改用匹配文档语义的 PDF 专用读取工具" : "提供 PNG、JPEG 或 BMP 图片"],
            retryable: isPdf,
            recoveryCandidateSet: "closed",
            recoveryCandidates: isPdf ? [{
              id: "route-pdf-to-document-reader",
              summary: "将 PDF 交给文档类型感知的读取工具",
              steps: [{
                instruction: "数据手册调用 datasheet_read；原理图调用 schematic_read。不要把同一 PDF 再次交给 ocr_image。",
                tools: ["datasheet_read", "schematic_read"],
                effects: ["workspace-read"],
              }],
            }] : [],
          },
        },
      }
    }

    // 1) 优先使用外部 OCR 引擎（RapidOCR-json，准确率更高）
    const extEngine = findExternalOcr()
    if (extEngine) {
      try {
        const text = await externalOcr(imgPath, extEngine)
        if (text) return { success: true, data: { text, engine: "rapidocr" } }
      } catch { /* fall through */ }
    }

    // 2) 内置 tesseract.js v4
    try {
      const text = await tessOcr(imgPath)
      if (text) return { success: true, data: { text, engine: "tesseract" } }
      return { success: true, data: { text: "(OCR 未识别到文字)", engine: "tesseract" } }
    } catch (err: any) {
      return { success: false, error: `OCR 失败: ${err.message}` }
    }
  },
  contract: { effects: ["workspace-read"], idempotency: "read-only", cancellation: "cooperative", progress: { role: "inspection", targetParameters: ["path"] } }, permission: "read",
})

function sniffOcrInputMime(bytes: Uint8Array): string | null {
  return IMAGE_MIME_BY_MAGIC.find(({ magic }) =>
    bytes.byteLength >= magic.length && magic.every((byte, index) => bytes[index] === byte))?.mime ?? null
}
