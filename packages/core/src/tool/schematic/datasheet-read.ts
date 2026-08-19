/**
 * datasheet_read 工具 — 器件手册/数据表读取与分析
 *
 * 支持 PDF 格式的芯片手册、传感器规格书、元器件数据表。
 * 使用 unpdf 提取文本内容，调用 LLM 做结构化分析。
 * 对于文本极少的图形型 PDF，回退到 vision 模型进行图像分析。
 */
import { defineTool } from "../../tool/define"
import type { ToolResult } from "../../tool/types"
import { safePath } from "../helpers"
import { llmClient } from "../../runtime/llm-client"
import { resolveToolModelCandidates, runToolModelInference } from "../../runtime/tool-model-inference"
import { documentIngestionPipeline } from "../../util/document-ingestion.ts"
import { extractPdfTextFromBuffer, renderPdfFirstPage } from "../../util/pdf"

export const datasheetReadTool = defineTool({
  name: "datasheet_read",
  description: `读取元器件数据手册/规格书 (PDF)，提取关键参数。

功能：
- 解析 PDF 格式的芯片手册、传感器规格书
- 提取核心参数：工作电压、电流、封装、接口、温度范围
- 识别电气特性表、引脚定义、典型应用电路
- 对比多个器件规格，生成选型对比表

参数：
- filePath: 手册文件路径 (PDF)
- extractFocus: 提取重点 (parameters/pins/application/all)
- compareWith: 对比的另一个文件路径 (可选，用于选型对比)`,

  permission: "read",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "手册文件路径" },
      extractFocus: {
        type: "string",
        enum: ["parameters", "pins", "application", "all"],
        description: "提取重点",
      },
      compareWith: { type: "string", description: "对比文件路径" },
    },
    required: ["filePath"],
  },

  contract: {
    effects: ["workspace-read"],
    runtimeDependencies: { modelCapabilities: ["chat", "vision"] },
    idempotency: "read-only",
    cancellation: "cooperative",
    progress: { role: "inspection", targetParameters: ["filePath", "compareWith"] },
  },

  async execute(params, ctx): Promise<ToolResult> {
    const focus = (params.extractFocus as string) ?? "all"
    let filePath: string
    try {
      filePath = safePath(ctx.workingDir, params.filePath as string)
    } catch {
      return { success: false, error: `文件路径越权: ${params.filePath}` }
    }
    let compareWith: string | undefined
    if (params.compareWith) {
      try {
        compareWith = safePath(ctx.workingDir, params.compareWith as string)
      } catch {
        return { success: false, error: `对比文件路径越权: ${params.compareWith}` }
      }
    }

    // 1. 验证文件
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      return { success: false, error: `文件不存在: ${filePath}` }
    }

    const ext = filePath.split(".").pop()?.toLowerCase()
    if (ext !== "pdf") {
      return { success: false, error: `不支持的文件格式: ${ext}。请使用 PDF 格式。` }
    }

    if (file.size > 20 * 1024 * 1024) {
      return { success: false, error: `文件过大 (${(file.size / 1024 / 1024).toFixed(1)}MB > 20MB)` }
    }

    const startTime = Date.now()
    const buffer = new Uint8Array(await file.arrayBuffer())
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath

    // 2. 先尝试文本提取（unpdf，支持大多数电子数据手册）
    let pdfText = ""
    let pdfPages = 0
    let isGraphical = false
    try {
      const extractRes = await documentIngestionPipeline.ingest({
        name: fileName,
        mime: "application/pdf",
        bytes: buffer,
        maxChars: 200_000,
      })
      pdfText = extractRes.text
      pdfPages = extractRes.pages
      isGraphical = extractRes.graphical
    } catch {
      // 文本提取失败 → 尝试 vision 回退
      isGraphical = true
    }

    const prompt = buildDatasheetPrompt(focus)

    // 3. 图形型 PDF（原理图类）→ vision 模型分析图片
    if (isGraphical || pdfText.length < 100) {
      const visionCandidates = resolveToolModelCandidates(ctx, "vision")
      if (visionCandidates.length === 0) {
        return {
          success: true,
          data: {
            filePath, fileSize: `${(file.size / 1024).toFixed(1)} KB`,
            title: fileName, type: "datasheet", source: filePath,
            summary: pdfPages > 0
              ? `[图形型 PDF，${pdfPages} 页，文本极少]\n未配置 Vision 模型，无法进行图像分析。建议：1) 配置带 vision 能力的模型 2) 将 PDF 导出为 PNG 图片后重新分析。${pdfText ? "\n\n文本摘要:\n" + pdfText.slice(0, 500) : ""}`
              : "未配置 Vision 模型，无法分析。",
          },
        }
      }

      // Vision 回退：渲染 PDF 首页为图片，发送给视觉模型
      const renderedImg = await renderPdfFirstPage(buffer).catch(() => null)
      if (!renderedImg) {
        // 无法渲染图片（sharp 不支持 PDF 或渲染失败）
        return {
          success: true,
          data: {
            filePath, fileSize: `${(file.size / 1024).toFixed(1)} KB`,
            title: fileName, type: "datasheet", source: filePath,
            summary: pdfText
              ? `[图形型 PDF，${pdfPages} 页]\n无法渲染 PDF 为图片（Bun 环境限制）。\n\n从 PDF 提取的文本片段：\n\`\`\`\n${pdfText.slice(0, 5000)}\n\`\`\``
              : `[图形型 PDF，${pdfPages} 页]\n无法渲染 PDF 为图片（Bun 环境限制）。建议将 PDF 导出为 PNG 图片后重新分析。`,
          },
        }
      }

      const messages: any[] = [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: renderedImg } },
          { type: "text", text: prompt },
        ],
      }]
      // 附加提取到的文本片段作为上下文
      if (pdfText) {
        messages[0].content.unshift({
          type: "text",
          text: `[从 PDF 提取的文本片段（${pdfPages} 页，${pdfText.length} 字符）]\n\`\`\`\n${pdfText.slice(0, 8000)}\n\`\`\`\n\n以上文本仅供参考，请以图片内容为准。`,
        })
      }

      let summary = ""
      let visionModel = visionCandidates[0]
      let modelAttempts = 0
      try {
        const inference = await runToolModelInference(ctx, {
          operation: "datasheet_read",
          capability: "vision",
          thinkingEnabled: false,
          system: "你是嵌入式硬件工程师，专注于芯片数据手册分析。请用中文简洁输出。",
          messages: () => messages,
        })
        summary = inference.text
        visionModel = inference.model
        modelAttempts = inference.attempts
      } catch (err: any) {
        return { success: false, error: `视觉分析失败: ${err.message}` }
      }

      summary = summary.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim()
      return {
        success: true,
        data: { filePath, fileSize: `${(file.size / 1024).toFixed(1)} KB`, summary, title: fileName, type: "datasheet", source: filePath, model: visionModel.name, modelAttempts, elapsedMs: Date.now() - startTime },
      }
    }

    // 4. 文本型 PDF（正常数据手册）→ 文本提取 + LLM 解析
    // 也加载对比文件文本
    let compareText = ""
    if (compareWith) {
      try {
        const cmpFile = Bun.file(compareWith)
        const cmpBuf = new Uint8Array(await cmpFile.arrayBuffer())
        const cmpRes = await extractPdfTextFromBuffer(cmpBuf, { maxChars: 100_000 })
        compareText = `\n\n## 对比文件: ${compareWith.split(/[/\\]/).pop()}\n\`\`\`\n${cmpRes.text.slice(0, 50000)}\n\`\`\``
      } catch { /* ignore */ }
    }

    // 使用任意可用模型（不强制 vision）做文本解析
    const routeResult = ctx.modelRouter?.route(["chat"])
    const modelConfig = routeResult?.model ?? ctx.modelRouter?.getModelForCapability("chat")
    if (!modelConfig) {
      // 纯本地：直接返回提取的文本
      return {
        success: true,
        data: {
          filePath, fileSize: `${(file.size / 1024).toFixed(1)} KB`,
          title: fileName, type: "datasheet", source: filePath,
          summary: pdfText.slice(0, 5000),
          note: "未配置 LLM 模型，已提取原始文本",
        },
      }
    }

    const textPrompt = `${prompt}\n\n## PDF 文件内容（${pdfPages} 页，${pdfText.length} 字符）\n\n\`\`\`\n${pdfText.slice(0, 100_000)}\n\`\`\`${compareText}`
    let summary = ""
    try {
      for await (const ev of llmClient.stream({
        model: modelConfig,
        system: "你是嵌入式硬件工程师，专注于芯片数据手册分析。请用中文输出结构化的分析报告。",
        messages: [{ role: "user", content: textPrompt }],
        maxSteps: 1,
        signal: ctx.abortSignal,
      })) {
        if (ev.type === "text-delta") summary += ev.text
        if (ev.type === "error") break
        if (ev.type === "finish") break
      }
    } catch {
      // LLM 调用失败 → 返回提取的原始文本
      summary = pdfText.slice(0, 5000)
    }

    summary = summary.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim()
    return {
      success: true,
      data: {
        filePath, fileSize: `${(file.size / 1024).toFixed(1)} KB`,
        summary: summary || pdfText.slice(0, 5000),
        title: fileName, type: "datasheet", source: filePath,
        model: modelConfig.name,
        elapsedMs: Date.now() - startTime,
        note: isGraphical ? "图形型 PDF，使用视觉模型分析" : undefined,
      },
    }
  },
})

function buildDatasheetPrompt(focus: string): string {
  const base = `你是一位资深的嵌入式硬件工程师。请分析这份元器件数据手册，提取以下关键信息：

## 提取要求

### 1. 基本信息
- 器件型号/系列
- 制造商
- 器件类型 (MCU/传感器/电源/接口/被动元件)
- 封装类型

### 2. 电气参数
| 参数 | 最小值 | 典型值 | 最大值 | 单位 | 条件 |
|------|--------|--------|--------|------|------|
| 工作电压 | | | | V | |
| 工作电流 | | | | mA | |
| 待机电流 | | | | μA | |
| 工作温度 | | | | °C | |

### 3. 引脚定义
| 引脚号 | 引脚名 | 类型 | 功能描述 |
|--------|--------|------|----------|

### 4. 关键特性
- 列出 5-10 个最重要的技术特性

### 5. 典型应用
- 推荐应用电路的关键元件值

### 6. 封装尺寸
- 封装类型和尺寸 (mm)

## 输出格式
请以 JSON 格式输出核心数据，同时用 Markdown 格式输出可读报告。`

  if (focus === "parameters") {
    return base + "\n\n## 重点关注\n请重点提取电气参数表格和工作条件。"
  }
  if (focus === "pins") {
    return base + "\n\n## 重点关注\n请重点提取引脚定义和封装尺寸。"
  }
  if (focus === "application") {
    return base + "\n\n## 重点关注\n请重点提取典型应用电路和外围元件选型建议。"
  }
  return base
}
