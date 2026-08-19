import { createHash } from "node:crypto"
import type { ToolContext, ToolResult } from "../tool/types.ts"
import type {
  ApprovalOutcome,
  ToolApprovalRequest,
} from "./tool-approval.ts"
import type {
  UserQuestionOutcome,
  UserQuestionRequest,
} from "./user-question.ts"
import { redactInternalImplementationData } from "./model-output-policy.ts"

export function extractCompileErrors(
  value: unknown,
): Array<{ file?: string; line?: number; message: string }> | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const manifest = record.process && typeof record.process === "object"
    ? record
    : record.details && typeof record.details === "object"
      ? record.details as Record<string, unknown>
      : undefined
  const processResult = manifest?.process
  if (!processResult || typeof processResult !== "object") return undefined
  const diagnostics = (processResult as Record<string, unknown>).diagnostics
  if (!Array.isArray(diagnostics)) return undefined
  const errors = diagnostics.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const diagnostic = item as Record<string, unknown>
    if (diagnostic.severity !== "error"
      || typeof diagnostic.message !== "string") return []
    return [{
      file: typeof diagnostic.file === "string" ? diagnostic.file : undefined,
      line: typeof diagnostic.line === "number" ? diagnostic.line : undefined,
      message: diagnostic.message,
    }]
  })
  return errors.length ? errors : undefined
}

/**
 * Feedback may explore another strategy only during automatic routing. A user
 * selected model is a hard primary preference and may change solely through
 * the ordinary failure fallback path, never because a tool made no progress.
 */
export function orderCandidateChainForFeedback<T>(
  candidates: T[],
  feedbackPressure: number,
  preservePrimary: boolean,
): T[] {
  if (preservePrimary || candidates.length < 2) return candidates
  const offset = Math.min(
    Math.max(0, Math.floor(feedbackPressure)),
    candidates.length - 1,
  )
  return offset > 0
    ? [...candidates.slice(offset), ...candidates.slice(0, offset)]
    : candidates
}

export function shouldAnnounceModelRoute(
  modelIdentity: string,
  lastAnnouncedIdentity: string,
): boolean {
  return modelIdentity !== lastAnnouncedIdentity
}

export function resolveToolUserInteraction(
  toolName: string,
  result: ToolResult,
): {
  question: string
  options: string[]
  purpose?: "target-confirmation" | "target-family-confirmation"
} | null {
  const data = result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : null
  const source = toolName === "question" && result.success
    ? data
    : data?.userInteraction && typeof data.userInteraction === "object"
      ? data.userInteraction as Record<string, unknown>
      : null
  if (!source || source.type && source.type !== "question") return null
  const question = typeof source.question === "string"
    ? source.question.trim()
    : ""
  if (!question) return null
  const options = Array.isArray(source.options)
    ? [...new Set(source.options
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean))]
      .slice(0, 4)
    : []
  const purpose = source.purpose === "target-family-confirmation"
    ? "target-family-confirmation" as const
    : source.purpose === "target-confirmation"
      ? "target-confirmation" as const
      : undefined
  return { question, options, ...(purpose ? { purpose } : {}) }
}

export async function requestParentApproval(
  broker: ToolContext["onSubAgentInteraction"],
  request: ToolApprovalRequest,
): Promise<ApprovalOutcome> {
  if (!broker) return "cancelled"
  const resolution = await broker({
    type: "approval-request",
    payload: { approval: request },
    requiresMainAgentReview: true,
    visibility: "internal",
  })
  return resolution.status === "approved"
    || resolution.status === "denied"
    || resolution.status === "expired"
    || resolution.status === "cancelled"
    ? resolution.status
    : "cancelled"
}

export async function requestParentQuestion(
  broker: ToolContext["onSubAgentInteraction"],
  request: UserQuestionRequest,
): Promise<UserQuestionOutcome> {
  if (!broker) return { status: "cancelled" }
  const resolution = await broker({
    type: "question-request",
    payload: { question: request },
    requiresMainAgentReview: true,
    visibility: "internal",
  })
  return resolution.status === "answered"
    ? { status: "answered", answer: resolution.answer }
    : { status: "cancelled" }
}

export function shouldRetryAfterUserInteraction(
  toolName: string,
  result: ToolResult,
): boolean {
  if (toolName !== "compile" && toolName !== "bash") return false
  const data = result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : null
  return data?.status === "target-identification-required"
    || data?.status === "target-build-evidence-required"
}

export function buildToolRecoveryHint(
  toolName: string,
  visibleToolNames: Set<string>,
): string {
  const canScript = visibleToolNames.has("bash")
    && visibleToolNames.has("write")
  const scriptHint = canScript
    ? "若没有可用的现成工具，可在 .eval/tmp 中编写并执行最小 Python/脚本工具；先检查依赖，完成后清理临时文件。"
    : "当前没有同时开放 bash 和 write，不要声称已经编写或执行脚本。"
  return `${toolName} 已失败。先根据错误修正参数、路径或输入，再尝试具备相同目标的其他可用工具；不要原样重复本次调用。${scriptHint} 所有替代路径都必须遵守当前目录、网络和审批策略。`
}

export function isOutputLimitFinish(reason: string): boolean {
  return ["length", "max_tokens", "max_output_tokens"]
    .includes(reason.toLowerCase())
}

/** Preserve structure and the diagnostically important tail of large output. */
export function formatToolResultForContext(
  result: unknown,
  executionId?: string,
  maxChars = 8_000,
  toolName?: string,
): unknown {
  const safe = redactInternalImplementationData(result)
  const serialized = typeof safe === "string" ? safe : JSON.stringify(safe)
  const effectiveMaxChars = ["schematic_read", "datasheet_read"]
    .includes(toolName ?? "")
    ? Math.max(maxChars, 48_000)
    : maxChars
  if (serialized.length <= effectiveMaxChars) return serialized
  const envelopeBudget = Math.max(1_000, effectiveMaxChars - 800)
  const headSize = Math.floor(envelopeBudget * 0.55)
  const tailSize = envelopeBudget - headSize
  return JSON.stringify({
    truncated: true,
    originalChars: serialized.length,
    sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
    executionId,
    head: serialized.slice(0, headSize),
    tail: serialized.slice(-tailSize),
    recovery: executionId
      ? "完整结果已按 executionId 保存在工具执行记录中供审计；当前上下文保留头尾。"
      : "结果过长，已保留头尾和内容哈希。",
  })
}
