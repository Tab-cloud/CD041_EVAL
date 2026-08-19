import type { ModelRouter } from "../model-router/index.ts"
import type { ModelCapability, ModelConfig } from "../model-router/types.ts"
import type { MessageRow, SessionRow } from "../store/repository.ts"
import { SessionRepo } from "../store/repository.ts"
import {
  CONTEXT_COMPACT_RATIO,
  CONTEXT_WARNING_RATIO,
  PROTOCOL_MESSAGE_LIMIT,
  assessContextPressure,
  buildAgentHistory,
  buildCompactionTranscript,
  buildFallbackSummary,
  chooseRowsToCompact,
  contextInputBudget,
  estimateAttachmentTokens,
  estimateTokens,
  parseCompactSummary,
  trimHistoryToCapacity,
  unsummarizedRows,
  type AgentHistoryMessage,
  type CompactSummaryPayload,
  type ContextPressure,
} from "./context-compaction.ts"
import { summarizeContextTranscript } from "./server-summary.ts"
import { estimateProjectedHistoryShape } from "./llm-client.ts"

export type ContextCompactionEvent = {
  status: "warning" | "start" | "complete" | "fallback"
  used: number
  total: number
  ratio: number
  threshold: number
  summary?: CompactSummaryPayload
  message: string
  breakdown: ContextPressure["breakdown"]
  protocolMessages: { used: number; total: number }
  limitingFactor: ContextPressure["limitingFactor"]
}

interface PrepareContextOptions {
  session: SessionRow
  rows: MessageRow[]
  incomingMessage: string
  attachments: Array<{ kind: "image" | "text" | "binary"; content?: string; dataUrl?: string }>
  model?: ModelConfig
  emit?: (event: ContextCompactionEvent) => void
}

export interface PreparedContext {
  history: AgentHistoryMessage[]
  pressure: ContextPressure
  summary: CompactSummaryPayload | null
  automaticallyCompacted: boolean
}

export function resolveContextModel(options: {
  modelRouter: ModelRouter | null
  preferredModelId?: string
  requiredCapabilities: ModelCapability[]
  hasImage: boolean
}): ModelConfig | undefined {
  const router = options.modelRouter
  if (!router) return undefined
  const preferred = options.preferredModelId ? router.getModel(options.preferredModelId) : undefined
  if (preferred) return preferred
  if (options.hasImage) {
    const vision = router.getModelForCapability("vision")
    if (vision) return vision
  }
  try {
    return router.route(options.requiredCapabilities).model
  } catch {
    return router.list[0]
  }
}

function pressureFor(
  history: AgentHistoryMessage[],
  options: Pick<PrepareContextOptions, "incomingMessage" | "attachments" | "model">,
): ContextPressure {
  const projected = options.model
    ? estimateProjectedHistoryShape(options.model, history)
    : undefined
  return assessContextPressure({
    history,
    incoming: options.incomingMessage,
    contextWindow: options.model?.contextWindow ?? 128_000,
    maxOutputTokens: options.model?.maxOutputTokens ?? 4_096,
    attachmentTokens: estimateAttachmentTokens(options.attachments),
    projectedHistoryTokens: projected?.tokens,
    projectedHistoryMessages: projected?.messages,
  })
}

function pressureEventFields(pressure: ContextPressure) {
  return {
    protocolMessages: { used: pressure.messageCount, total: pressure.messageLimit },
    limitingFactor: pressure.limitingFactor,
  }
}

function pressureStatusMessage(pressure: ContextPressure, compacting: boolean): string {
  if (pressure.limitingFactor === "messages") {
    return compacting
      ? `对话协议深度达到 ${pressure.messageCount}/${pressure.messageLimit}，正在准备压缩`
      : `对话协议深度超过 70%（${pressure.messageCount}/${pressure.messageLimit}），将在 80% 时自动压缩`
  }
  return compacting
    ? "上下文达到自动压缩阈值，正在准备压缩"
    : "上下文容量超过 70%，将在 80% 时自动压缩"
}

export async function prepareConversationContext(options: PrepareContextOptions): Promise<PreparedContext> {
  let summary = parseCompactSummary(options.session)
  let activeRows = unsummarizedRows(options.rows, summary)
  let history = buildAgentHistory(options.rows, summary)
  let pressure = pressureFor(history, options)
  const emit = options.emit ?? (() => undefined)

  if (pressure.ratio >= CONTEXT_WARNING_RATIO) {
    emit({
      status: "warning",
      used: pressure.estimatedTokens,
      total: pressure.inputBudget,
      ratio: pressure.ratio,
      threshold: CONTEXT_WARNING_RATIO,
      breakdown: pressure.breakdown,
      ...pressureEventFields(pressure),
      message: pressureStatusMessage(pressure, pressure.ratio >= CONTEXT_COMPACT_RATIO),
    })
  }

  if (pressure.ratio < CONTEXT_COMPACT_RATIO) {
    return { history, pressure, summary, automaticallyCompacted: false }
  }

  const inputBudget = contextInputBudget(
    options.model?.contextWindow ?? 128_000,
    options.model?.maxOutputTokens ?? 4_096,
  )
  const split = chooseRowsToCompact(activeRows, inputBudget)
  if (split.compact.length === 0) {
    const historyBudget = Math.max(
      512,
      Math.floor(inputBudget * 0.75)
        - estimateTokens(options.incomingMessage)
        - estimateAttachmentTokens(options.attachments),
    )
    history = trimHistoryToCapacity(history, historyBudget, Math.floor(PROTOCOL_MESSAGE_LIMIT * 0.72))
    pressure = pressureFor(history, options)
    emit({
      status: "fallback",
      used: pressure.estimatedTokens,
      total: pressure.inputBudget,
      ratio: pressure.ratio,
      threshold: CONTEXT_COMPACT_RATIO,
      breakdown: pressure.breakdown,
      ...pressureEventFields(pressure),
      message: "没有可独立摘要的早期消息，已执行安全截断",
    })
    return { history, pressure, summary, automaticallyCompacted: false }
  }

  emit({
    status: "start",
    used: pressure.estimatedTokens,
    total: pressure.inputBudget,
    ratio: pressure.ratio,
    threshold: CONTEXT_COMPACT_RATIO,
    breakdown: pressure.breakdown,
    ...pressureEventFields(pressure),
    message: `正在压缩 ${split.compact.length} 条早期消息`,
  })

  const originalTokens = pressure.estimatedTokens
  const transcriptLimit = Math.min(
    80_000,
    Math.max(8_000, Math.floor((options.model?.contextWindow ?? 128_000) * 1.7)),
  )
  const transcript = buildCompactionTranscript(summary, split.compact, transcriptLimit)
  const generated = options.model
    ? await summarizeContextTranscript(transcript, options.model)
    : null
  const mode = generated ? "auto" : "fallback"
  const content = generated ?? buildFallbackSummary(summary, split.compact)
  const throughSeq = split.compact.at(-1)!.seq

  summary = {
    content,
    timestamp: Date.now(),
    throughSeq,
    mode,
    originalTokens,
  }
  activeRows = unsummarizedRows(options.rows, summary)
  history = buildAgentHistory(options.rows, summary)
  pressure = pressureFor(history, options)

  // 摘要后重新校验；仍偏高时只裁剪未摘要的最近历史，不删除摘要和当前用户消息。
  if (pressure.ratio >= CONTEXT_COMPACT_RATIO) {
    const historyBudget = Math.max(
      512,
      Math.floor(inputBudget * 0.72)
        - estimateTokens(options.incomingMessage)
        - estimateAttachmentTokens(options.attachments),
    )
    history = trimHistoryToCapacity(history, historyBudget, Math.floor(PROTOCOL_MESSAGE_LIMIT * 0.72))
    pressure = pressureFor(history, options)
  }

  const compactedTokens = pressure.estimatedTokens
  summary = SessionRepo.setCompact(options.session.id, content, {
    throughSeq,
    mode,
    originalTokens,
    compactedTokens,
  })
  // 使用数据库中的权威时间重建前缀，throughSeq 保证不会再次注入已摘要消息。
  history = buildAgentHistory(options.rows, summary)
  if (pressure.ratio >= CONTEXT_COMPACT_RATIO) {
    const historyBudget = Math.max(512, Math.floor(inputBudget * 0.72) - estimateTokens(options.incomingMessage))
    history = trimHistoryToCapacity(history, historyBudget, Math.floor(PROTOCOL_MESSAGE_LIMIT * 0.72))
    pressure = pressureFor(history, options)
  }

  emit({
    status: mode === "auto" ? "complete" : "fallback",
    used: pressure.estimatedTokens,
    total: pressure.inputBudget,
    ratio: pressure.ratio,
    threshold: CONTEXT_COMPACT_RATIO,
    breakdown: pressure.breakdown,
    ...pressureEventFields(pressure),
    summary,
    message: mode === "auto"
      ? `自动压缩完成，保留 ${activeRows.length} 条近期消息`
      : `摘要模型不可用，已使用安全摘录并保留 ${activeRows.length} 条近期消息`,
  })

  return { history, pressure, summary, automaticallyCompacted: true }
}
