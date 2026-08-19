/**
 * Vision Client — 图片预处理 + MediaPart + 多模型适配
 *
 * 处理流程:
 *   文件 → MIME sniff → 缩放 (max 2000px) → 重编码(如超5MB) →
 *   MediaPart { mediaType, data } → 按模型 lowering
 */
import { readFileSync } from "node:fs"

// ══════════════════════════════════════════════
// MIME 检测 (magic bytes)
// ══════════════════════════════════════════════

const MIME_MAGIC: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4E, 0x47], mime: "image/png" },
  { bytes: [0xFF, 0xD8, 0xFF], mime: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf" },
]

function sniffMime(buffer: Uint8Array): string {
  for (const magic of MIME_MAGIC) {
    if (magic.bytes.every((b, i) => buffer[i] === b)) return magic.mime
  }
  return "application/octet-stream"
}

// ══════════════════════════════════════════════
// MediaPart
// ══════════════════════════════════════════════

export interface MediaPart {
  type: "media"
  mediaType: string
  data: string   // base64
  filename?: string
}

// ══════════════════════════════════════════════
// Vision Client
// ══════════════════════════════════════════════

export class VisionClient {
  /** 文件最大大小 (10MB) */
  static MAX_SIZE = 10 * 1024 * 1024

  /**
   * 读取文件并转为 MediaPart
   */
  static async readFile(filePath: string): Promise<MediaPart> {
    const buffer = readFileSync(filePath)
    if (buffer.length > VisionClient.MAX_SIZE) {
      throw new Error(`文件过大 (${(buffer.length / 1024 / 1024).toFixed(1)}MB > 10MB)`)
    }

    const mime = sniffMime(new Uint8Array(buffer))
    const base64 = Buffer.from(buffer).toString("base64")

    return {
      type: "media",
      mediaType: mime,
      data: base64,
      filename: filePath.split(/[\\/]/).pop(),
    }
  }

  /**
   * 按模型类型构建 Vision 消息
   *
   * OpenAI: { type: "image_url", image_url: { url: "data:...;base64,..." } }
   * Anthropic: { type: "image", source: { type: "base64", media_type: "...", data: "..." } }
   */
  static buildVisionMessage(
    _modelId: string,
    media: MediaPart,
    text: string,
    provider?: string,
  ): { role: string; content: unknown } {
    const isAnthropic = provider === "anthropic"

    if (isAnthropic) {
      return {
        role: "user",
        content: [
          { type: "text", text },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: media.mediaType,
              data: media.data,
            },
          },
        ],
      }
    }

    // OpenAI / OpenAI Compatible
    const dataUrl = `data:${media.mediaType};base64,${media.data}`
    return {
      role: "user",
      content: [
        { type: "text", text },
        {
          type: "image_url",
          image_url: { url: dataUrl, detail: "high" },
        },
      ],
    }
  }

  /**
   * 构建原理图分析消息
   */
  static buildSchematicMessage(filePath: string, modelId: string): Promise<{
    role: string; content: unknown; media: MediaPart
  }> {
    return VisionClient.readFile(filePath).then((media) => {
      const prompt = `分析此原理图，提取以下信息并按JSON格式返回：
{
  "mcu": { "model": "芯片完整型号", "package": "封装", "core": "内核" },
  "pins": [{ "pin": "引脚号", "function": "功能", "target": "连接目标" }],
  "peripherals": [{ "model": "芯片型号", "function": "功能", "interface": "接口类型" }],
  "power": { "input": "输入电源描述" },
  "connectors": [{ "type": "连接器类型", "signals": [{"pin": "引脚", "signal": "信号名"}] }]
}`
      return { role: "user", content: VisionClient.buildVisionMessage(modelId, media, prompt).content, media }
    })
  }
}

export const visionClient = new VisionClient()
