export interface TerminalDeliveryEvent {
  status?: unknown
  result?: unknown
  problem?: {
    message?: unknown
  }
}

/**
 * The desktop client only renders delivery data produced by the runtime.
 * It never invents a successful answer from a terminal status.
 */
export function resolveTerminalDelivery(currentText: string, event: TerminalDeliveryEvent): string {
  if (currentText.trim()) return currentText
  if (typeof event.result === "string" && event.result.trim()) return event.result.trim()
  if (typeof event.problem?.message === "string" && event.problem.message.trim()) {
    return event.problem.message.trim()
  }
  return ""
}

export function isDeliveredCompletion(event: TerminalDeliveryEvent, text: string): boolean {
  return event.status === "completed" && text.trim().length > 0
}
