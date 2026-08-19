import type { ToolResult } from "./types.ts"

/**
 * Classify all model-authored input failures under one stable fault domain.
 *
 * The concrete validation message is evidence for the next repair attempt,
 * but it must not mint a fresh recovery budget for every missing nested field.
 * Recovery therefore retries only the same native tool with corrected input;
 * unrelated workspace inspection can never keep a protocol failure alive.
 */
export function invalidToolInputResult(
  toolName: string,
  error: unknown,
): ToolResult {
  const detail = error instanceof Error ? error.message : String(error)
  const summary = `工具参数无效: ${detail}`
  return {
    success: false,
    error: summary,
    outcome: {
      status: "failed",
      category: "generic",
      summary,
      fingerprint: `tool-input-invalid:${toolName}`,
      diagnostic: {
        kind: "tool-input-invalid",
        evidence: [detail.slice(0, 2_000)],
        nextActions: [`按 ${toolName} 的当前 JSON Schema 修正参数类型和必填字段后重试`],
        retryable: true,
        recoveryCandidateSet: "closed",
        recoveryCandidates: [{
          id: "repair-native-tool-input",
          summary: `修正 ${toolName} 的原生工具参数`,
          steps: [{
            instruction: `根据验证错误修正参数，并通过原生 ${toolName} 工具重试；不要把对象序列化成字符串，也不要调用无关工具。`,
            tools: [toolName],
            effects: [],
          }],
        }],
      },
    },
  }
}

/** Ensure every tool crossing the registry boundary has a runtime outcome. */
export function normalizeToolResult(toolName: string, result: ToolResult): ToolResult {
  if (result.outcome) {
    const outcomeSucceeded = result.outcome.status === "succeeded"
    if (outcomeSucceeded !== result.success) {
      const summary = `工具 ${toolName} 返回了矛盾的 success/outcome 状态`
      return {
        success: false,
        error: summary,
        data: result.data,
        outcome: {
          status: "failed",
          category: "generic",
          summary,
          fingerprint: `contract:${toolName}:inconsistent-outcome`,
          diagnostic: {
            kind: "tool-contract-violation",
            evidence: [`success=${result.success}`, `outcome.status=${result.outcome.status}`],
            nextActions: ["修复工具实现，使 success 与 outcome.status 保持一致"],
          },
        },
      }
    }
    return result
  }
  if (result.success) {
    return {
      ...result,
      outcome: { status: "succeeded", category: "generic", summary: "工具执行成功" },
    }
  }
  const summary = result.error?.trim() || "工具执行失败"
  const status = /取消|abort/i.test(summary) ? "cancelled" : /超时|timeout/i.test(summary) ? "timed-out" : "failed"
  return {
    ...result,
    outcome: {
      status,
      category: "generic",
      summary,
      fingerprint: buildToolFailureFingerprint(toolName, summary),
    },
  }
}

export function buildToolFailureFingerprint(toolName: string, error: unknown): string {
  return `${toolName}: ${String(error ?? "工具执行失败")}`
    .replace(/[A-Z]:[/\\][^:\r\n]+/gi, "<path>")
    .replace(/:\d+(?::\d+)?/g, ":#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}
