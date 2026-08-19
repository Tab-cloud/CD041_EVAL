import type { AssistantPart, AssistantPartEvent, ChatMessage } from "./types"

/** Apply an idempotent server-owned part event to its request-bound message. */
export function applyAssistantPartEvent(
  messages: ChatMessage[],
  event: AssistantPartEvent,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.requestId !== event.requestId) return message
    const parts = [...(message.parts ?? [])]
    const index = parts.findIndex((part) => part.id === event.partId)
    const current = index >= 0 ? parts[index] : undefined
    const next = reducePart(current, event)
    if (index >= 0) parts[index] = next
    else parts.push(next)
    return {
      ...message,
      parts,
      content: event.partType === "text" ? visibleText(parts) : message.content,
    }
  })
}

export function visibleReasoningParts(message: ChatMessage): AssistantPart[] {
  return (message.parts ?? []).filter((part) => part.type === "reasoning" && part.state !== "discarded")
}

/**
 * A request terminal is the final presentation invariant. Explicit part-end
 * events remain authoritative, while this idempotent settlement prevents a
 * degraded or legacy stream from leaving the UI in a permanent streaming state.
 */
export function settleAssistantPartsForRequest(
  messages: ChatMessage[],
  requestId: string,
  outcome: "completed" | "discarded",
  timestamp: number,
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || message.requestId !== requestId || !message.parts?.length) {
      return message
    }
    let changed = false
    const parts = message.parts.map((part) => {
      if (part.state !== "streaming") return part
      changed = true
      return {
        ...part,
        state: outcome,
        endedAt: Math.max(part.startedAt, timestamp),
      } satisfies AssistantPart
    })
    return changed ? { ...message, parts } : message
  })
}

function reducePart(current: AssistantPart | undefined, event: AssistantPartEvent): AssistantPart {
  if (current?.lastEventSeq !== undefined && event.seq !== undefined && event.seq <= current.lastEventSeq) {
    return current
  }
  const startedAt = current?.startedAt ?? event.timestamp
  if (event.status === "start") {
    return current ?? {
      id: event.partId,
      type: event.partType,
      text: "",
      state: "streaming",
      startedAt,
      ...(event.seq !== undefined ? { lastEventSeq: event.seq } : {}),
    }
  }
  if (event.status === "delta") {
    return {
      id: event.partId,
      type: event.partType,
      text: appendDelta(current?.text ?? "", event.text ?? ""),
      state: current?.state === "discarded" ? "discarded" : "streaming",
      startedAt,
      ...(current?.endedAt ? { endedAt: current.endedAt } : {}),
      ...(event.seq !== undefined ? { lastEventSeq: event.seq } : {}),
    }
  }
  return {
    id: event.partId,
    type: event.partType,
    text: current?.text ?? "",
    state: event.outcome === "discarded" ? "discarded" : "completed",
    startedAt,
    endedAt: Math.max(startedAt, event.timestamp),
    ...(event.seq !== undefined ? { lastEventSeq: event.seq } : {}),
  }
}

function appendDelta(current: string, delta: string): string {
  return current + delta
}

function visibleText(parts: AssistantPart[]): string {
  return parts
    .filter((part) => part.type === "text" && part.state !== "discarded")
    .map((part) => part.text)
    .join("")
}
