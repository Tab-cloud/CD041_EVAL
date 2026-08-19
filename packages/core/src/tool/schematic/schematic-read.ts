/**
 * schematic_read 工具
 *
 * 读取原理图文件（PDF/PNG/JPG），调用视觉模型进行分析，
 * 提取芯片型号、引脚映射、外设配置等结构化信息。
 *
 * PDF: 先提取文本，若为图形型 PDF 则尝试视觉分析（附文本上下文）
 * 图片: 直接发送给视觉模型分析
 */
import { defineTool } from "../define.ts"
import type { ToolResult } from "../types.ts"
import { VisionClient } from "../../vision/client.ts"
import { llmClient } from "../../runtime/llm-client.ts"
import { resolveToolModelCandidates, runToolModelInference } from "../../runtime/tool-model-inference.ts"
import {
  cropImageDataUrl,
  extractPdfPageText,
  extractPdfPageTextLayout,
  extractPdfTextFromBuffer,
  locatePdfQuestionRegion,
  renderPdfPageDetailed,
  type PdfNormalizedRegion,
  type PdfTextLayout,
} from "../../util/pdf.ts"
import { safePath } from "../helpers"

export const schematicReadTool = defineTool({
  name: "schematic_read",
  description: `读取原理图文件（PDF、PNG、JPG、PNG格式），使用视觉模型分析电路设计。

功能：
- 识别 MCU 型号和封装
- 提取引脚映射（引脚号 → 功能 → 网络名）
- 识别外设芯片（传感器、存储器、通信芯片等）
- 分析电源设计（LDO/DC-DC、去耦电容）
- 识别接口类型（UART/SPI/I2C/USB/CAN/SWD）

参数：
- filePath: 原理图文件的绝对路径
- pageNumber: PDF 文件的页码（可选，默认分析第 1 页）
- focus: 分析重点（可选: "mcu" | "peripherals" | "power" | "connectors" | "all"）
- question: 需要从图形中精确核查的问题，例如“U3 pin4 是否通过导线连接到 GND”`,

  permission: "schematic",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "原理图文件路径" },
      pageNumber: { type: "number", description: "PDF 页码 (1-indexed)" },
      question: { type: "string", description: "需要视觉模型重点核查的引脚、网络或器件连接问题" },
      focus: {
        type: "string",
        enum: ["mcu", "peripherals", "power", "connectors", "all"],
        description: "分析重点",
      },
    },
    required: ["filePath"],
  },

  contract: {
    effects: ["workspace-read"],
    runtimeDependencies: { modelCapabilities: ["reasoning", "vision"] },
    idempotency: "read-only",
    cancellation: "cooperative",
    progress: { role: "inspection", targetParameters: ["filePath"] },
  },

  async execute(params, ctx): Promise<ToolResult> {
    const focus = (params.focus as string) ?? "all"
    const pageNumber = params.pageNumber as number | undefined
    const question = typeof params.question === "string" ? params.question.trim().slice(0, 2_000) : ""
    const rawPath = params.filePath as string
    if (pageNumber !== undefined && (!Number.isInteger(pageNumber) || pageNumber < 1)) {
      return { success: false, error: "pageNumber 必须是从 1 开始的整数" }
    }

    // 收容路径到工作目录，防止越权读
    let filePath: string
    try {
      filePath = safePath(ctx.workingDir, rawPath)
    } catch {
      return { success: false, error: `路径越权: ${rawPath}` }
    }

    // 1. 文件类型检测
    const ext = filePath.split(".").pop()?.toLowerCase()
    if (!["pdf", "png", "jpg", "jpeg", "webp", "gif"].includes(ext ?? "")) {
      return { success: false, error: `不支持的文件格式: ${ext}。支持 PDF、PNG、JPG、WEBP、GIF。` }
    }

    // 2. 读取/渲染文件为 Vision 可用格式
    const file = Bun.file(filePath)
    if (!(await file.exists())) return { success: false, error: `文件不存在: ${filePath}` }
    if (file.size > 20 * 1024 * 1024) return { success: false, error: "文件过大（最大 20MB）" }
    const fileBuf = new Uint8Array(await file.arrayBuffer())
    const fileSizeKB = (fileBuf.byteLength / 1024).toFixed(1)
    const isPdf = ext === "pdf"

    let media: { type: "media"; mediaType: string; data: string } | null = null
    let pdfContext = ""
    let renderEngine: string | undefined
    let renderErrors: string[] = []
    let textLayout: PdfTextLayout | null = null
    let targetRegion: PdfNormalizedRegion | null = null
    let renderedPageDataUrl = ""

    if (isPdf) {
      // PDF: 先提取文本作为上下文，再渲染首页为图片供视觉分析
      try {
        const extractRes = pageNumber
          ? await extractPdfPageText(fileBuf, pageNumber, 50_000)
          : await extractPdfTextFromBuffer(fileBuf, { maxChars: 50_000 })
        if (extractRes.text.length > 20) {
          pdfContext = `\n\n[PDF 文本内容（${extractRes.pages} 页，${extractRes.text.length} 字符），辅助视觉分析]\n\`\`\`\n${extractRes.text.slice(0, 8000)}\n\`\`\``
        }
        if (question) {
          textLayout = await extractPdfPageTextLayout(fileBuf, pageNumber ?? 1)
          targetRegion = locatePdfQuestionRegion(textLayout, question)
        }
      } catch (error) {
        if (pageNumber) return { success: false, error: error instanceof Error ? error.message : String(error) }
      }

      // 渲染用户指定页；未指定时分析首页。
      const rendered = await renderPdfPageDetailed(fileBuf, pageNumber ?? 1).catch((error) => ({
        dataUrl: null,
        renderer: undefined,
        errors: [error instanceof Error ? error.message : String(error)],
      }))
      renderEngine = rendered.renderer
      renderErrors = rendered.errors
      if (rendered.dataUrl) {
        renderedPageDataUrl = rendered.dataUrl
        const match = rendered.dataUrl.match(/^data:(.+);base64,(.+)$/)
        if (match) {
          media = { type: "media", mediaType: match[1], data: match[2] }
        }
      }

      if (!media) {
        // 所有渲染器均不可用时，继续调用文本模型分析已提取内容，而不是直接返回原文。
        if (pdfContext) {
          const textModel = ctx.preferredModelId
            ? ctx.modelRouter?.getModel(ctx.preferredModelId)
            : ctx.modelRouter?.route(["reasoning"]).model
          const collected: string[] = []
          let modelError = ""
          if (textModel) {
            for await (const event of llmClient.stream({
              model: textModel,
              system: "你是嵌入式硬件工程师。PDF 转图失败，请根据提取文本分析原理图，并明确无法从文本确认的连线。",
              messages: [{ role: "user", content: buildAnalysisPrompt(focus, pageNumber, question) + pdfContext }],
              signal: ctx.abortSignal,
            })) {
              if (event.type === "text-delta") collected.push(event.text)
              else if (event.type === "error") modelError = event.message
            }
          }
          return {
            success: true,
            data: {
              filePath, fileSize: `${fileSizeKB} KB`,
              pageNumber: pageNumber ?? 1, focus,
              analysis: collected.join("").trim() || `[PDF 文本降级结果]\n\n${pdfContext}`,
              visionUsed: false,
              visionAttempted: false,
              analysisMode: "text-fallback",
              pdfConvertedToPng: false,
              renderErrors,
              note: modelError || "所有 PDF 转 PNG 方式均失败，视觉模型未收到图片，已使用文本模型降级分析。",
            },
          }
        }
        return { success: false, error: `无法分析此 PDF：所有转图方式均失败且没有可提取文本。${renderErrors.join("；")}` }
      }
    } else {
      // 图片文件：直接读取
      try {
        media = await VisionClient.readFile(filePath)
      } catch (err: any) {
        return { success: false, error: `读取文件失败: ${err.message ?? err}` }
      }
    }

    // 3. 查找可用的视觉模型
    const visionCandidates = resolveToolModelCandidates(ctx, "vision")
    if (visionCandidates.length === 0) {
      return { success: false, error: "没有可用的视觉模型。请在模型配置中添加带 vision 能力的模型。" }
    }

    // 4. 构建分析提示词 + 调用
    // 精确连线问题必须依赖带坐标的视觉证据。PDF 文本层只有阅读顺序、
    // 没有器件/引脚坐标，把它拼入提示会诱发“网络名正确但引脚位置错误”。
    // 全页概览仍可使用文本层辅助识别器件型号和普通标签。
    const prompt = buildAnalysisPrompt(focus, pageNumber, question) + (question ? "" : pdfContext)
    const startTime = Date.now()
    try {
      const inference = await runToolModelInference(ctx, {
        operation: "schematic_read",
        capability: "vision",
        candidateModels: visionCandidates,
        thinkingEnabled: false,
        system: "你是一位资深的嵌入式硬件工程师，擅长分析电路原理图。请严格按照提示词格式输出分析结果。不要在报告正文中披露模型名称、供应商、modelId、路由评分或内部渲染器信息。",
        messages: (model) => [VisionClient.buildVisionMessage(model.modelId, media!, prompt, model.provider) as any],
      })
      const verification = question
        ? await verifyPreciseSchematicFinding({
            ctx,
            question,
            primaryAnalysis: inference.text,
            pageDataUrl: renderedPageDataUrl,
            targetRegion,
            textLayout,
            candidates: visionCandidates.length > 1
              ? [...visionCandidates.slice(1), visionCandidates[0]]
              : visionCandidates,
          })
        : null
      const elapsed = Date.now() - startTime
      const review = schematicReviewAssessment(verification?.verdict)
      const analysis = verification
        ? `[复核状态：${review.label}]\n${review.guidance}\n\n${inference.text}\n\n## 独立复核\n${verification.text}`
        : inference.text
      return {
        success: true,
        data: {
          filePath,
          fileSize: `${fileSizeKB} KB`,
          pageNumber: pageNumber ?? 1,
          focus,
          model: inference.model.name,
          modelId: inference.model.modelId,
          modelProvider: inference.model.provider,
          modelAttempts: inference.attempts,
          outputContinuationSegments: inference.continuationSegments,
          elapsedMs: elapsed,
          analysis,
          review: {
            mode: "advisory",
            confidence: review.confidence,
            requiresCorroboration: review.requiresCorroboration,
            guidance: review.guidance,
          },
          verification: verification ? {
            verdict: verification.verdict,
            independentModelUsed: verification.independentModelUsed,
            coordinateEvidenceUsed: Boolean(targetRegion),
            targetRegion,
          } : undefined,
          visionUsed: true,
          visionAttempted: true,
          analysisMode: "vision",
          pdfConvertedToPng: isPdf,
          imageMediaType: media?.mediaType,
          renderEngine,
          renderWarnings: renderErrors,
        },
      }
    } catch (err: any) {
      return { success: false, error: `视觉模型调用异常: ${err.message ?? err}` }
    }
  },
})

type VerificationVerdict = "CONFIRMED" | "CONFLICT" | "INSUFFICIENT"

function schematicReviewAssessment(verdict?: VerificationVerdict) {
  if (verdict === "CONFIRMED") {
    return {
      label: "独立证据一致",
      confidence: "high",
      requiresCorroboration: false,
      guidance: "可以继续进行设计审查；形成最终引脚映射前仍应与数据手册和程序定义交叉核对。",
    } as const
  }
  if (verdict === "CONFLICT") {
    return {
      label: "证据存在冲突",
      confidence: "low",
      requiresCorroboration: true,
      guidance: "继续审查并列出冲突双方、坐标证据和待核项，不因冲突中止整份原理图分析。",
    } as const
  }
  return {
    label: verdict === "INSUFFICIENT" ? "局部证据不足" : "未执行独立复核",
    confidence: verdict === "INSUFFICIENT" ? "low" : "medium",
    requiresCorroboration: Boolean(verdict),
    guidance: "继续完成可见设计事实的审查，对无法确认的映射明确标注不确定性，不把它作为停止审查的门控条件。",
  } as const
}

async function verifyPreciseSchematicFinding(options: {
  ctx: Parameters<typeof runToolModelInference>[0]
  question: string
  primaryAnalysis: string
  pageDataUrl: string
  targetRegion: PdfNormalizedRegion | null
  textLayout: PdfTextLayout | null
  candidates: ReturnType<typeof resolveToolModelCandidates>
}): Promise<{ verdict: VerificationVerdict; text: string; independentModelUsed: boolean }> {
  if (!options.targetRegion || !options.pageDataUrl) {
    return {
      verdict: "INSUFFICIENT",
      text: "VERDICT: INSUFFICIENT\n未能从 PDF 文字坐标定位出足够小的目标区域，整页视觉结论未获得局部空间证据复核。",
      independentModelUsed: false,
    }
  }
  const cropped = await cropImageDataUrl(options.pageDataUrl, options.targetRegion)
  const matchSet = new Set(options.targetRegion.matchedText)
  const coordinateEvidence = options.textLayout?.items
    .filter((item) => matchSet.has(item.text))
    .slice(0, 40)
    .map((item) => `${item.text}@(${item.x.toFixed(4)},${item.y.toFixed(4)},${item.width.toFixed(4)},${item.height.toFixed(4)})`)
    .join("; ") ?? ""
  const media = parseDataUrl(cropped)
  const verifier = await runToolModelInference(options.ctx, {
    operation: "schematic_verify",
    capability: "vision",
    candidateModels: options.candidates,
    thinkingEnabled: false,
    system: "你是独立的原理图证据复核员。只检查局部裁剪图和坐标文字证据，不延续首次分析的假设。",
    messages: (model) => [VisionClient.buildVisionMessage(model.modelId, media, `请独立复核以下精确连线结论。\n\n问题：${options.question}\n\n首次分析：${options.primaryAnalysis}\n\nPDF 坐标文字证据（x,y,w,h 均为页面归一化坐标）：${coordinateEvidence || "无"}\n\n必须从以下标记之一开始：\nVERDICT: CONFIRMED\nVERDICT: CONFLICT\nVERDICT: INSUFFICIENT\n\n只有局部图中的引脚号、引脚名、导线和网络标号形成可连续追踪的证据链，且与首次分析一致时，才能选择 CONFIRMED。随后简述证据或冲突。`, model.provider) as any],
  })
  const verdict = parseVerificationVerdict(verifier.text)
  return {
    verdict,
    text: verifier.text,
    independentModelUsed: options.candidates.length > 1 && verifier.model.id === options.candidates[0]?.id,
  }
}

function parseDataUrl(dataUrl: string): { type: "media"; mediaType: string; data: string } {
  const match = dataUrl.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/)
  if (!match) throw new Error("局部图像编码无效")
  return { type: "media", mediaType: match[1], data: match[2] }
}

function parseVerificationVerdict(text: string): VerificationVerdict {
  const match = text.match(/VERDICT:\s*(CONFIRMED|CONFLICT|INSUFFICIENT)/i)
  return (match?.[1]?.toUpperCase() as VerificationVerdict | undefined) ?? "INSUFFICIENT"
}

/**
 * 构建原理图分析的提示词
 */
function buildAnalysisPrompt(focus: string, pageNumber?: number, question?: string): string {
  const pageHint = pageNumber ? `（共分析第 ${pageNumber} 页）` : ""
  if (question) {
    return `请只核查这张原理图${pageHint}中的以下问题，不要扩展为整份原理图报告：

${question}

## 核查规则
- 只依据图片中实际可见的器件位号、引脚号、引脚名、绿色导线、连接点、网络标号和电源符号作答
- 从目标引脚开始逐段追踪导线，明确写出“引脚 -> 导线/连接点 -> 网络标号或终点”
- 严格区分不同器件的同名引脚和不同页的元件，不得把其他器件的电容、电阻或网络归到目标器件
- 原理图只能证明“实际怎么连接”；芯片手册才能证明“应该怎么连接”。不得从图片推断 MCU 内核、存储容量或芯片规范
- 看不清或导线终点不在当前页时标记“证据不足”，不得用器件常识补全
- 不要生成无关的完整引脚表，不要复述历史审核报告

## 输出格式
1. 观察证据：器件位号、引脚号/名称、可见导线路径、网络标号或终点
2. 图纸事实：已连接 / 明确悬空 / 当前页无法确认
3. 规范判断：仅在随附文本中存在明确数据手册证据时给出，否则写“需查数据手册”
4. 置信度：高 / 中 / 低，并说明限制`
  }
  const base = `请分析这张原理图${pageHint}，提取以下信息。

## 分析要求

### 1. MCU 主控
- 芯片型号（完整型号，如 STM32F103C8T6）
- 封装类型（LQFP48/QFN32/BGA 等）
- 内核、主频、Flash、SRAM 等数据手册属性只能标记为“需数据手册核对”，不得从原理图图片猜测
- 电源引脚连接（VDD/VDDA/VBAT）
- 复位电路设计
- 晶振频率（HSE/LSE）
- 调试接口（SWD/JTAG 引脚）

### 2. 引脚映射
请以表格形式列出每个已连接引脚的映射：
| 引脚号 | 引脚名 | 功能 | 连接目标 | 网络标号 |

只列出图片中能够清晰辨认并沿导线确认的引脚。不得为了补全表格而推测缺失项。

### 3. 外设芯片
列出原理图中除 MCU 外的所有 IC：
- 芯片型号
- 功能描述
- 与 MCU 的接口类型（SPI/I2C/UART/USB 等）
- 使用的 MCU 引脚

### 4. 电源设计
- 输入电源（USB/VBAT/外部电源）
- 稳压器型号（如 AMS1117-3.3）
- 输出电压和最大电流
- 去耦电容配置

### 5. 接口连接器
- 排针/插座型号
- 引脚定义
- 对外接口协议

## 输出格式
请以 JSON 格式输出核心数据，同时用 Markdown 格式输出可读的分析报告。

JSON 格式：
\`\`\`json
{
  "mcu": {
    "model": "芯片完整型号",
    "package": "封装",
    "core": "内核",
    "maxFreq": "最大主频",
    "flash": "Flash大小",
    "sram": "SRAM大小"
  },
  "pins": [
    { "pin": "引脚号", "name": "引脚名", "function": "功能", "target": "连接目标", "net": "网络标号" }
  ],
  "peripherals": [
    { "model": "芯片型号", "function": "功能", "interface": "接口类型", "mcuPins": ["MCU引脚列表"] }
  ],
  "power": {
    "input": "输入电源描述",
    "regulators": [{ "model": "稳压器型号", "output": "输出电压", "maxCurrent": "最大电流" }]
  },
  "connectors": [
    { "type": "连接器类型", "pins": "引脚数", "signals": [{ "pin": "引脚", "signal": "信号名" }] }
  ],
  "unconnectedPins": ["未连接的 GPIO 引脚列表"]
}

\`\`\``

  if (focus === "mcu") {
    return base + "\n\n## 重点\n本次分析请重点关注 MCU 主控芯片及其引脚映射。"
  }
  if (focus === "peripherals") {
    return base + "\n\n## 重点\n本次分析请重点关注外设芯片及其与 MCU 的连接关系。"
  }
  if (focus === "power") {
    return base + "\n\n## 重点\n本次分析请重点关注电源电路设计。"
  }
  if (focus === "connectors") {
    return base + "\n\n## 重点\n本次分析请重点关注对外接口连接器。"
  }
  return base
}
