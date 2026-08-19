import { describe, expect, test } from "bun:test"
import {
  applyAssistantPartEvent,
  settleAssistantPartsForRequest,
  visibleReasoningParts,
} from "../src/chat-message-parts"
import type { AssistantPartEvent, ChatMessage } from "../src/types"

describe("request-bound assistant parts", () => {
  test("server timestamps preserve a multi-second reasoning interval even when deltas arrive at the end", () => {
    let messages = conversation("request-a")
    messages = apply(messages, event("request-a", "reasoning:a", "reasoning", "start", 1_000))
    messages = apply(messages, { ...event("request-a", "reasoning:a", "reasoning", "delta", 27_500), text: "推理摘要" })
    messages = apply(messages, { ...event("request-a", "reasoning:a", "reasoning", "end", 27_600), outcome: "completed" })

    expect(visibleReasoningParts(messages[1]!)).toEqual([expect.objectContaining({
      text: "推理摘要",
      state: "completed",
      startedAt: 1_000,
      endedAt: 27_600,
    })])
  })

  test("concurrent requests cannot write into another assistant message", () => {
    let messages = [...conversation("request-a"), ...conversation("request-b")]
    messages = apply(messages, { ...event("request-b", "text:b", "text", "delta", 2), text: "B" })

    expect(messages.find((message) => message.requestId === "request-a" && message.role === "assistant")?.content).toBe("")
    expect(messages.find((message) => message.requestId === "request-b" && message.role === "assistant")?.content).toBe("B")
  })

  test("a discarded attempt is removed before fallback text is committed", () => {
    let messages = conversation("request-a")
    messages = apply(messages, { ...event("request-a", "text:first", "text", "delta", 2, 1), text: "partial" })
    messages = apply(messages, { ...event("request-a", "text:first", "text", "end", 3, 2), outcome: "discarded" })
    messages = apply(messages, { ...event("request-a", "text:fallback", "text", "delta", 4, 3), text: "stable" })

    expect(messages[1]?.content).toBe("stable")
  })

  test("durable replay ignores an already applied sequence", () => {
    const delta = { ...event("request-a", "text:a", "text", "delta", 2, 7), text: "once" }
    let messages = apply(conversation("request-a"), delta)
    messages = apply(messages, delta)

    expect(messages[1]?.content).toBe("once")
  })

  test("a request terminal idempotently closes streaming parts when part-end events are unavailable", () => {
    let messages = conversation("request-a")
    messages = apply(messages, event("request-a", "reasoning:a", "reasoning", "start", 1_000))
    messages = apply(messages, { ...event("request-a", "text:a", "text", "delta", 2_000), text: "answer" })

    messages = settleAssistantPartsForRequest(messages, "request-a", "completed", 3_000)
    messages = settleAssistantPartsForRequest(messages, "request-a", "completed", 4_000)

    expect(messages[1]?.parts).toEqual([
      expect.objectContaining({ id: "reasoning:a", state: "completed", endedAt: 3_000 }),
      expect.objectContaining({ id: "text:a", state: "completed", endedAt: 3_000 }),
    ])
    expect(messages[1]?.content).toBe("answer")
  })
})

function conversation(requestId: string): ChatMessage[] {
  return [
    { role: "user", requestId, content: "question", timestamp: 1 },
    { role: "assistant", requestId, content: "", timestamp: 1 },
  ]
}

function event(
  requestId: string,
  partId: string,
  partType: "reasoning" | "text",
  status: "start" | "delta" | "end",
  timestamp: number,
  seq?: number,
): AssistantPartEvent {
  return { requestId, partId, partType, status, timestamp, ...(seq === undefined ? {} : { seq }) }
}

function apply(messages: ChatMessage[], input: AssistantPartEvent): ChatMessage[] {
  return applyAssistantPartEvent(messages, input)
}
