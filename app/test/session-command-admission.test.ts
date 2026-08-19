import { describe, expect, test } from "bun:test"
import { commandToInstruction, type PublicSessionCommand } from "../src/session-commands"

describe("durable chat admission projection", () => {
  test("a polled command keeps its request identity and safe attachment summary", () => {
    const command: PublicSessionCommand = {
      requestId: "request-pdf",
      sessionId: "session-1",
      sessionSeq: 1,
      state: "pending",
      createdAt: 1,
      text: "请看一下这个文档，主要讲了什么",
      effort: "on",
      modelId: null,
      workingDir: null,
      attachments: [{
        name: "kimi技术报告.pdf",
        size: 1024,
        kind: "binary",
      }],
    }

    const instruction = commandToInstruction(command)

    expect(instruction.requestId).toBe("request-pdf")
    expect(instruction.taskId).toBeUndefined()
    expect(instruction.attachments).toEqual([{
      name: "kimi技术报告.pdf",
      size: 1024,
      kind: "binary",
      path: "",
      mime: "",
    }])
  })
})
