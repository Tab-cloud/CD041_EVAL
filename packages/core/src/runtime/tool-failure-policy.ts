import type { ToolResult } from "../tool/types.ts"

export type ToolFailureDisposition = "continue" | "recover" | "terminal"

export interface ToolFailureControlDecision {
  disposition: ToolFailureDisposition
  source: "tool" | "runtime-default"
}

/**
 * Convert a typed tool outcome into loop control. Tools own domain meaning;
 * the runtime supplies only a conservative default for legacy results.
 * Human-readable error text is deliberately excluded from this decision.
 */
export function resolveToolFailureControl(
  result: ToolResult,
): ToolFailureControlDecision {
  const diagnostic = result.outcome?.diagnostic
  if (diagnostic?.failureDisposition) {
    return { disposition: diagnostic.failureDisposition, source: "tool" }
  }
  if (diagnostic?.retryable === false) {
    // "Non-retryable" means the exact failed invocation must not be repeated.
    // It does not revoke the main Agent's authority to inspect the evidence,
    // choose another authorized tool, re-plan, or ask the user for permission.
    return { disposition: "continue", source: "tool" }
  }
  return { disposition: "recover", source: "runtime-default" }
}
