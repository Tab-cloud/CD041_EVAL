import { describe, expect, test } from "bun:test"
import {
  isRetryableSessionCommandError,
  commandToInstruction,
  instructionSubmissionMessage,
  SessionCommandSubmissionError,
  stageInstructionAttachments,
} from "../src/session-commands"
import type { QueuedInstruction } from "../src/store"

function instructionWithAttachment(bytes: Uint8Array): QueuedInstruction {
  return {
    id: "large-attachment",
    requestId: `large-attachment-${Date.now()}`,
    sessionId: "attachment-test",
    text: "分析这个文档",
    attachments: [{
      name: "large-document.pdf",
      path: "",
      size: bytes.byteLength,
      mime: "application/pdf",
      kind: "binary",
      dataBase64: Buffer.from(bytes).toString("base64"),
    }],
    scope: "auto-edit",
    effort: "on",
    modelId: null,
    workingDir: null,
    createdAt: Date.now(),
    serverState: "local",
  }
}

describe("session command attachment staging", () => {
  test("gives attachment-only instructions an executable backend message", () => {
    expect(instructionSubmissionMessage("", 1)).toBe("请分析随附文件。")
    expect(instructionSubmissionMessage("总结附件", 1)).toBe("总结附件")
    expect(instructionSubmissionMessage("", 0)).toBe("")
  })

  test("drops inline attachment bytes after durable command admission", () => {
    const instruction = instructionWithAttachment(new Uint8Array([1, 2, 3]))
    const projected = commandToInstruction({
      requestId: instruction.requestId,
      sessionId: instruction.sessionId!,
      sessionSeq: 1,
      state: "pending",
      createdAt: instruction.createdAt,
      text: instruction.text,
      effort: "on",
      modelId: null,
      workingDir: null,
      attachments: [{ name: "large-document.pdf", size: 3, kind: "binary" }],
    }, instruction)

    expect(projected.attachments[0].dataBase64).toBeUndefined()
    expect(projected.attachments[0]).toMatchObject({
      name: "large-document.pdf",
      size: 3,
      mime: "application/pdf",
      kind: "binary",
    })
  })

  test("uploads a document larger than the old 10MB JSON boundary as raw bytes", async () => {
    const bytes = new Uint8Array(12 * 1024 * 1024)
    bytes[0] = 0x25
    bytes[bytes.length - 1] = 0x46
    let uploadedLength = 0

    const staged = await stageInstructionAttachments(
      instructionWithAttachment(bytes),
      async (path, init) => {
        expect(path).toContain("/api/attachments?")
        expect(init?.method).toBe("POST")
        uploadedLength = (await new Response(init?.body).arrayBuffer()).byteLength
        return Response.json({
          attachment: {
            name: "large-document.pdf",
            size: uploadedLength,
            mime: "application/pdf",
            kind: "binary",
            uploadId: "a".repeat(64),
          },
        }, { status: 201 })
      },
    )

    expect(uploadedLength).toBe(bytes.byteLength)
    expect(staged).toEqual([{
      name: "large-document.pdf",
      size: bytes.byteLength,
      mime: "application/pdf",
      kind: "binary",
      uploadId: "a".repeat(64),
    }])
    expect(JSON.stringify(staged).length).toBeLessThan(1_000)
  })

  test("treats HTTP 413 as a visible terminal submission error", () => {
    const error = new SessionCommandSubmissionError("附件超过 32MB", false, 413)
    expect(isRetryableSessionCommandError(error)).toBe(false)
    expect(isRetryableSessionCommandError(new Error("Failed to fetch"))).toBe(true)
  })

  test("rejects a total larger than 64MB before submitting the command", async () => {
    const instruction = instructionWithAttachment(new Uint8Array(1))
    instruction.attachments = [32 * 1024 * 1024, 32 * 1024 * 1024, 1].map((size, index) => ({
      name: `part-${index}.bin`,
      path: "",
      size,
      mime: "application/octet-stream",
      kind: "binary" as const,
      uploadId: String(index + 1).repeat(64),
    }))

    await expect(stageInstructionAttachments(instruction, async () => {
      throw new Error("transport must not be called")
    })).rejects.toMatchObject({ status: 413, retryable: false })
  })

  test("rejects a malformed attachment staging response", async () => {
    const instruction = instructionWithAttachment(new Uint8Array([1, 2, 3]))

    await expect(stageInstructionAttachments(instruction, async () => Response.json({
      attachment: {
        name: "large-document.pdf",
        size: 3,
        mime: "application/pdf",
        kind: "binary",
        uploadId: "not-a-content-digest",
      },
    }, { status: 201 }))).rejects.toMatchObject({ status: 502, retryable: true })
  })

  test("rejects more than ten attachments instead of silently dropping them", async () => {
    const instruction = instructionWithAttachment(new Uint8Array(1))
    instruction.attachments = Array.from({ length: 11 }, (_, index) => ({
      name: `part-${index}.bin`,
      path: "",
      size: 1,
      mime: "application/octet-stream",
      kind: "binary" as const,
      uploadId: "a".repeat(64),
    }))

    await expect(stageInstructionAttachments(instruction)).rejects.toMatchObject({
      status: 413,
      retryable: false,
    })
  })
})
