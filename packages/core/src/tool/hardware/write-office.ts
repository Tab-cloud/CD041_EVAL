import { defineTool } from "../define"
import { safePath } from "../helpers"
import { buildOfficeFile, officeExt, type OfficeFormat } from "../../util/office-write"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const writeOfficeTool = defineTool({
  name: "write_office",
  description: "将文本内容写入 Office 文档（DOCX / XLSX / PPTX），支持 Markdown 转格式。",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "要写入的文本内容。DOCX 为 Markdown 文本；XLSX 为 TSV（制表符分隔）；PPTX 以 '---' 分隔幻灯片。" },
      format: { type: "string", description: "输出格式：docx / xlsx / pptx" },
      path: { type: "string", description: "输出文件路径（含文件名，如 docs/report.docx）" },
    },
    required: ["content", "format", "path"],
  },

  permission: "write",
  contract: { effects: ["workspace-write"], idempotency: "idempotent", cancellation: "unsupported", progress: { role: "mutation", targetParameters: ["path"] } },

  async execute({ content, format, path }: { content: string; format: string; path: string }, ctx: any) {
    const allowedFormats: OfficeFormat[] = ["docx", "xlsx", "pptx"]
    if (!allowedFormats.includes(format as OfficeFormat)) {
      return { success: false, error: `不支持的格式: ${format}。可选: docx, xlsx, pptx` }
    }
    const fmt = format as OfficeFormat
    const abs = safePath(ctx.workingDir, path)
    const outPath = abs.endsWith(officeExt(fmt)) ? abs : abs + officeExt(fmt)
    try {
      // 确保目录存在
      const dir = dirname(outPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const bytes = await buildOfficeFile(content, fmt)
      writeFileSync(outPath, bytes)
      return { success: true, data: { format: fmt, path: outPath, size: bytes.length } }
    } catch (err: any) {
      return { success: false, error: `写入失败: ${err.message}` }
    }
  },
})
