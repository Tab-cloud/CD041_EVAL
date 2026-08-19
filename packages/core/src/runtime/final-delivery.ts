import type { ExecutionSnapshot } from "./agent-loop-control.ts"

export type FinalDeliveryEvent = (
  | { type: "finish"; finishReason: "stop" }
  | { type: "text-delta"; text: string }
) & {
  _step: number
  deliverySource: FinalDeliverySource
}

export type FinalDeliverySource = "model" | "runtime-fallback"

export interface FinalDeliveryResolution {
  text: string
  source: FinalDeliverySource
  diagnostic?: string
}

export interface FinalDeliveryInput {
  snapshot: ExecutionSnapshot
  modelText?: string
  modelError?: string
}

/**
 * Presentation is downstream of execution and must not own execution state.
 * A final-delivery policy may replace an unavailable model summary, but it can
 * never promote or demote the evidence-backed snapshot it receives.
 */
export abstract class FinalDeliveryPolicy {
  abstract resolve(input: FinalDeliveryInput): FinalDeliveryResolution
}

/**
 * Prefer a safe model-authored delivery. If the optional summarization turn is
 * empty or protocol-invalid, derive a minimal delivery from runtime-owned
 * objective state and evidence bindings instead.
 */
export class EvidenceBackedFinalDeliveryPolicy extends FinalDeliveryPolicy {
  resolve(input: FinalDeliveryInput): FinalDeliveryResolution {
    const modelText = input.modelText?.trim()
    const modelError = input.modelError?.trim()
    if (modelText && !modelError) return { text: modelText, source: "model" }

    const snapshot = input.snapshot
    const completed = snapshot.state === "completed"
    const mutatedTargets = evidenceTargets(snapshot, "workspace-mutation")
    const verifiedTargets = evidenceTargets(snapshot, "workspace-inspection")
    const completedTodos = snapshot.todos
      .filter((todo) => todo.status === "completed")
      .map((todo) => todo.content.trim())
      .filter(Boolean)
    const outstandingTodos = snapshot.todos
      .filter((todo) => todo.status !== "completed")
      .map((todo) => todo.content.trim())
      .filter(Boolean)

    const lines = completed
      ? ["任务已完成。"]
      : ["任务已停止，尚未完成。"]

    if (mutatedTargets.length > 0) {
      lines.push(`已生成并验证：${mutatedTargets.map(code).join("、")}`)
    } else if (verifiedTargets.length > 0) {
      lines.push(`已读取并验证：${verifiedTargets.map(code).join("、")}`)
    } else if (completedTodos.length > 0) {
      lines.push(`已完成：${completedTodos.slice(0, 3).join("；")}`)
    }

    if (!completed && outstandingTodos.length > 0) {
      lines.push(`尚待处理：${outstandingTodos.slice(0, 3).join("；")}`)
    }
    if (!completed && snapshot.stopReason) lines.push(`停止原因：${snapshot.stopReason}`)

    return {
      text: lines.join("\n\n"),
      source: "runtime-fallback",
      diagnostic: modelError || "最终总结未产生可交付正文",
    }
  }
}

export const finalDeliveryPolicy = new EvidenceBackedFinalDeliveryPolicy()

/**
 * Publish fallback text through the same typed part lifecycle as provider text.
 * The delta precedes finish so presentation closes the part with a server-owned
 * end timestamp while durable message aggregation remains independent.
 */
export function finalDeliveryEvents(
  delivery: FinalDeliveryResolution,
  step: number,
): FinalDeliveryEvent[] {
  return [
    {
      type: "text-delta",
      text: delivery.text,
      _step: step,
      deliverySource: delivery.source,
    },
    {
      type: "finish",
      finishReason: "stop",
      _step: step,
      deliverySource: delivery.source,
    },
  ]
}

function evidenceTargets(
  snapshot: ExecutionSnapshot,
  kind: "workspace-mutation" | "workspace-inspection",
): string[] {
  return [...new Set(
    (snapshot.objectiveEvidenceBindings ?? [])
      .filter((binding) => binding.kind === kind)
      .flatMap((binding) => binding.targets)
      .map((target) => target.trim())
      .filter(Boolean),
  )].slice(0, 8)
}

function code(value: string): string {
  return `\`${value.replace(/`/g, "")}\``
}
