import { describe, expect, test } from "bun:test"
import {
  conversationBranchTarget,
  rewindConversationMessages,
} from "../src/conversation-branch"
import type { ChatMessage } from "../src/types"

describe("conversation branch replacement", () => {
  test("removes the edited user turn and every later reply", () => {
    const messages: ChatMessage[] = [
      message("user", "first", "request-1", 1),
      message("assistant", "first reply", "request-1", 2),
      message("user", "second", "request-2", 3),
      message("assistant", "old reply", "request-2", 4),
    ]
    const target = conversationBranchTarget(messages[2])

    expect(target).toEqual({ requestId: "request-2", seq: 3 })
    expect(rewindConversationMessages(messages, target!)).toEqual(messages.slice(0, 2))
  })

  test("does not make an optimistic message without durable identity editable", () => {
    expect(conversationBranchTarget(message("user", "local", undefined, undefined))).toBeNull()
  })
})

function message(
  role: ChatMessage["role"],
  content: string,
  requestId: string | undefined,
  seq: number | undefined,
): ChatMessage {
  return { role, content, requestId, seq, timestamp: seq ?? 0 }
}
