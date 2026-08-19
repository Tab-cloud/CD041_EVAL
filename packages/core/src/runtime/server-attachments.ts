/**
 * server-attachments.ts — 附件处理器
 * PDF / DOC / DOCX / XLSX / PPTX 二进制 → 纯文本提取
 */
import { documentIngestionPipeline, isPdfDocument } from "../util/document-ingestion.ts"
import { isOfficeDocument } from "../util/office"
import { EVAL_DATA_DIR } from "../store/runtime-data-paths.ts"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"

export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
export const MAX_TOTAL_ATTACHMENT_BYTES = 64 * 1024 * 1024
export const MAX_ATTACHMENT_UPLOAD_BODY_BYTES = MAX_ATTACHMENT_BYTES
export const MAX_ATTACHMENT_COUNT = 10

const UPLOAD_ID_PATTERN = /^[a-f0-9]{64}$/
const UPLOAD_DIR = join(EVAL_DATA_DIR, "attachment-uploads")

export interface StagedAttachmentReference {
  name: string
  size: number
  mime: string
  kind: "image" | "text" | "binary"
  uploadId: string
}

export class AttachmentProcessingError extends Error {}

export async function processAttachments(
  raw: any[],
  workingDir: string,
): Promise<Array<{ name: string; mime: string; kind: "image" | "text" | "binary"; dataUrl?: string; content?: string }>> {
  if (!Array.isArray(raw)) throw new AttachmentProcessingError("附件列表无效")
  if (raw.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentProcessingError("单次指令最多提交 10 个附件")
  }
  const out: any[] = []
  let totalBytes = 0
  for (const a of raw) {
    if (!a || typeof a.name !== "string" || !a.name.trim()) continue
    const name = a.name.slice(0, 255)
    const mime = typeof a.mime === "string" ? a.mime.slice(0, 100) : "application/octet-stream"
    const kind = a.kind ?? (a.mime?.startsWith("image/") ? "image" : a.mime === "application/pdf" ? "text" : "binary")
    const stagedBytes = typeof a.uploadId === "string"
      ? await readStagedAttachment(a.uploadId, name)
      : undefined
    // 已经有 content / dataUrl 的直接用
    if (kind === "image" && (stagedBytes || typeof a.dataUrl === "string")) {
      const dataUrl = stagedBytes
        ? stagedImageDataUrl(stagedBytes, mime, name)
        : a.dataUrl
      if (typeof dataUrl === "string" && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
        totalBytes = reserveBytes(totalBytes, stagedBytes?.byteLength ?? estimatedBase64Bytes(dataUrl.split(",", 2)[1] ?? ""), name)
        out.push({ name, mime, kind, dataUrl })
      } else {
        throw new AttachmentProcessingError(`图片附件数据无效: ${name}`)
      }
      continue
    }
    if (kind === "text" && (stagedBytes || typeof a.content === "string")) {
      const content = stagedBytes ? Buffer.from(stagedBytes).toString("utf8") : a.content
      totalBytes = reserveBytes(totalBytes, stagedBytes?.byteLength ?? Buffer.byteLength(content, "utf8"), name)
      out.push({ name, mime, kind, content: content.slice(0, 200_000) })
      continue
    }
    const bytes = stagedBytes ?? decodeAttachmentBytes(a.dataBase64, name)
    totalBytes = reserveBytes(totalBytes, bytes.byteLength, name)

    // 文档统一从上传字节解析。所有 PDF 都暂存为内容寻址文件：是否需要图形证据
    // 由任务决定，不能因为文本提取量较多就让 schematic_read 丢失原始页面。
    if (isPdfDocument(name, mime, bytes) || isOfficeDocument(name, mime)) {
      try {
        const document = await documentIngestionPipeline.ingest({
          name,
          mime,
          bytes,
          maxChars: 200_000,
        })
        const stagedPath = document.format === "PDF"
          ? await stageAttachment(bytes, name, workingDir)
          : undefined
        const pdfHint = document.format === "PDF"
          ? document.graphical
            ? `\n\n[提示: 此 PDF 文本极少，可能为原理图/电路图。纯文本分析会丢失布局信息。如需详细电路分析，请调用 schematic_read 工具读取暂存文件 ${stagedPath}。]`
            : `\n\n[提示: 原始 PDF 已暂存为 ${stagedPath}。当任务需要页面图形、布局或指定页证据时，请按内容类型调用 schematic_read 或 datasheet_read，不要只依赖提取文本。]`
          : ""
        const pageLabel = document.format === "XLSX"
          ? `${document.pages} sheets`
          : document.pages > 0 ? `${document.pages} 页` : ""
        out.push({
          name, mime, kind: "text",
          content: `[${document.format}${pageLabel ? ` · ${pageLabel}` : ""}${document.truncated ? " · 已截断" : ""}]${pdfHint}\n\n${document.text}`,
        })
        console.log(`[document] extracted ${document.format}, ${document.pages} units, ${document.text.length} chars from ${name}${document.graphical ? " [图形PDF]" : ""}`)
      } catch (err) {
        throw new AttachmentProcessingError(`文档解析失败 ${name}: ${errorMessage(err)}`)
      }
      continue
    }
    out.push({ name, mime, kind: "binary", content: `[已接收 ${bytes.byteLength} 字节；当前没有适用于此格式的解析器]` })
  }
  return out
}

function decodeAttachmentBytes(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new AttachmentProcessingError(`附件缺少有效字节数据: ${name}`)
  }
  const size = estimatedBase64Bytes(value)
  if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentProcessingError(`附件超过 32MB: ${name}`)
  const bytes = Uint8Array.from(Buffer.from(value, "base64"))
  if (bytes.byteLength !== size) throw new AttachmentProcessingError(`附件 Base64 长度无效: ${name}`)
  return bytes
}

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
}

function reserveBytes(total: number, incoming: number, name: string): number {
  if (incoming > MAX_ATTACHMENT_BYTES) throw new AttachmentProcessingError(`附件超过 32MB: ${name}`)
  if (total + incoming > MAX_TOTAL_ATTACHMENT_BYTES) throw new AttachmentProcessingError("附件总大小超过 64MB")
  return total + incoming
}

export async function stageUploadedAttachment(input: {
  name: string
  mime: string
  kind: string
  bytes: Uint8Array
}): Promise<StagedAttachmentReference> {
  const name = input.name.trim().slice(0, 255)
  if (!name) throw new AttachmentProcessingError("附件名称不能为空")
  if (input.bytes.byteLength === 0) throw new AttachmentProcessingError(`附件内容为空: ${name}`)
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentProcessingError(`附件超过 32MB: ${name}`)
  }
  const mime = input.mime.trim().slice(0, 100) || "application/octet-stream"
  const kind = input.kind === "image" || input.kind === "text" || input.kind === "binary"
    ? input.kind
    : "binary"
  const uploadId = createHash("sha256").update(input.bytes).digest("hex")
  const uploadPath = join(UPLOAD_DIR, uploadId)
  await mkdir(UPLOAD_DIR, { recursive: true })
  if (!existsSync(uploadPath)) await writeFile(uploadPath, input.bytes)
  return { name, size: input.bytes.byteLength, mime, kind, uploadId }
}

async function readStagedAttachment(uploadId: string, name: string): Promise<Uint8Array> {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new AttachmentProcessingError(`附件暂存引用无效: ${name}`)
  }
  try {
    const bytes = new Uint8Array(await readFile(join(UPLOAD_DIR, uploadId)))
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentProcessingError(`附件超过 32MB: ${name}`)
    }
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== uploadId) throw new AttachmentProcessingError(`附件暂存内容校验失败: ${name}`)
    return bytes
  } catch (error) {
    if (error instanceof AttachmentProcessingError) throw error
    throw new AttachmentProcessingError(`附件暂存内容不可用: ${name}`)
  }
}

function stagedImageDataUrl(bytes: Uint8Array, mime: string, name: string): string {
  if (!/^image\/(?:png|jpeg|gif|webp)$/.test(mime)) {
    throw new AttachmentProcessingError(`图片附件类型无效: ${name}`)
  }
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

async function stageAttachment(bytes: Uint8Array, name: string, workingDir: string): Promise<string> {
  const digest = createHash("sha256").update(bytes).digest("hex")
  const extension = /^\.[a-z0-9]{1,10}$/i.test(extname(name)) ? extname(name).toLowerCase() : ".bin"
  const relativePath = `.eval/attachments/${digest}${extension}`
  const absolutePath = join(workingDir, relativePath)
  await mkdir(join(workingDir, ".eval", "attachments"), { recursive: true })
  if (!existsSync(absolutePath)) await writeFile(absolutePath, bytes)
  return relativePath.replace(/\\/g, "/")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
