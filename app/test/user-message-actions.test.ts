import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const appRoot = resolve(import.meta.dir, "..")

describe("historical user message actions", () => {
  test("aligns the action row to the right edge of the user bubble", () => {
    const styles = readFileSync(resolve(appRoot, "src/styles.css"), "utf8")
    const actions = styles.match(/\.user-msg-actions\s*\{([^}]*)\}/s)?.[1] ?? ""
    expect(actions).toContain("justify-content: flex-end")
  })

  test("opens an inline editor and resubmits through the replacement branch path", () => {
    const userMessage = readFileSync(resolve(appRoot, "src/components/UserMessage.tsx"), "utf8")
    const chatView = readFileSync(resolve(appRoot, "src/components/ChatView.tsx"), "utf8")
    const workspace = readFileSync(resolve(appRoot, "src/components/AppWorkspace.tsx"), "utf8")
    expect(userMessage).toContain("<UserMessageEditor")
    expect(userMessage).toContain("编辑并重新发送此消息")
    expect(chatView).toContain("onResubmit={resubmitHistoricalMessage}")
    expect(chatView).toContain("await onResubmit(source, content, scope, effort)")
    expect(workspace).toContain("conversationBranchTarget(source)")
    expect(workspace).toContain("branchFrom")
  })
})
