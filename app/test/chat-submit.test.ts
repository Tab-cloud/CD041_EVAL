import { describe, expect, test } from "bun:test"
import { canSubmitChat, normalizeHistoricalResubmission, selectSlashCommand, shouldClearChatComposer } from "../src/chat-submit"

describe("chat submission availability", () => {
  test("allows attachment-only instructions", () => {
    expect(canSubmitChat(false, 1)).toBe(true)
    expect(canSubmitChat(false, 0)).toBe(false)
    expect(canSubmitChat(true, 0)).toBe(true)
  })

  test("keeps text and attachments when the local queue rejects admission", () => {
    expect(shouldClearChatComposer(false)).toBe(false)
    expect(shouldClearChatComposer(undefined)).toBe(true)
  })

  test("normalizes an edited historical message before resubmission", () => {
    expect(normalizeHistoricalResubmission("  revised task\n")).toBe("revised task")
    expect(normalizeHistoricalResubmission(" \n\t ")).toBeNull()
  })

  test("executes clear immediately instead of only erasing the composer", () => {
    expect(selectSlashCommand("/clear")).toEqual({ kind: "execute", command: "/clear" })
    expect(selectSlashCommand("/review")).toEqual({ kind: "compose", text: "/review " })
  })
})
