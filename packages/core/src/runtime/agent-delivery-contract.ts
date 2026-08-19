/**
 * Public delivery is a protocol boundary, not presentation sugar.
 *
 * A model turn may advance the run by either:
 * - producing at least one native tool call; or
 * - producing non-empty text that survives the public-output policy.
 *
 * A completed root run has the stronger invariant that it must contain a
 * non-empty public delivery. Tool traces, reasoning and an LLM `finish` event
 * are never substitutes for that delivery.
 */

export const EMPTY_MODEL_TURN_ERROR = "模型返回空响应，未产生正文或原生工具调用"
export const EMPTY_MAIN_AGENT_DELIVERY_ERROR = "主 Agent 未产生可交付回复，任务不能标记为完成"
export const EXECUTABLE_MANUAL_HANDOFF_ERROR = "Bash 已授权暴露，但模型把可执行命令转交用户手动运行"

export interface ModelTurnDelivery {
  publicText: string
  nativeToolCallCount: number
}

export function hasPublicDelivery(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function validateModelTurnDelivery(delivery: ModelTurnDelivery):
  | { valid: true }
  | { valid: false; reason: string } {
  if (delivery.nativeToolCallCount > 0) return { valid: true }
  if (!hasPublicDelivery(delivery.publicText)) return { valid: false, reason: EMPTY_MODEL_TURN_ERROR }
  return { valid: true }
}

export function validateCompletedRunDelivery(value: unknown):
  | { valid: true }
  | { valid: false; reason: string } {
  if (hasPublicDelivery(value)) return { valid: true }
  return { valid: false, reason: EMPTY_MAIN_AGENT_DELIVERY_ERROR }
}

/**
 * A visible shell is an executable protocol surface. Models must not replace
 * it with a copy/paste handoff merely because the invocation may require an
 * approval. This check is intentionally narrow: it requires both a shell code
 * block and explicit instructions for the user to run it, and it yields to an
 * explicit request for instructions rather than execution.
 */
export function detectExecutableManualHandoff(input: {
  modelText: string
  userMessage: string
  availableToolNames: readonly string[]
}): string | null {
  if (!input.availableToolNames.includes("bash")) return null
  if (isInstructionOnlyRequest(input.userMessage)) return null
  const shellBlock = /```\s*(?:powershell|pwsh|bash|sh|shell|cmd|batch|bat)\b[^\r\n]*[\r\n][\s\S]*?```/i
  if (!shellBlock.test(input.modelText)) return null
  const manualDelegation = /(?:请|你(?:需要|要|只需|可以)|打开|另开|手动|等你)[^\r\n。！？]{0,80}(?:运行|执行|复制|粘贴|终端|powershell|命令|脚本)|(?:please|you\s+(?:need|have|should|must|can)|manually)[^\r\n.!?]{0,100}(?:run|execute|copy|paste|terminal|powershell|command|script)/i
  return manualDelegation.test(input.modelText)
    ? EXECUTABLE_MANUAL_HANDOFF_ERROR
    : null
}

function isInstructionOnlyRequest(message: string): boolean {
  return /(?:怎么|如何|怎样)[^\r\n。！？]{0,40}(?:运行|执行|使用)|(?:给我|提供|写出)[^\r\n。！？]{0,30}(?:命令|脚本|步骤|教程)|\bhow\s+to\b|\b(?:show|give|provide)\s+me\b[^\r\n.!?]{0,40}\b(?:command|script|steps|instructions)\b/i
    .test(message)
}
