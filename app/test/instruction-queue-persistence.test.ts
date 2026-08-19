import { afterEach, describe, expect, test } from "bun:test"
import { loadInstructionQueue, saveInstructionQueue } from "../src/store-persistence"
import type { QueuedInstruction } from "../src/store"

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage)
  else delete (globalThis as { localStorage?: Storage }).localStorage
})

describe("instruction queue persistence", () => {
  test("falls back to a visible failed record when inline bytes exceed localStorage", () => {
    let stored = ""
    let writes = 0
    const storage = {
      getItem: () => stored || null,
      setItem: (_key: string, value: string) => {
        writes += 1
        if (writes === 1) throw new DOMException("quota", "QuotaExceededError")
        stored = value
      },
      removeItem: () => { stored = "" },
      clear: () => { stored = "" },
      key: () => null,
      get length() { return stored ? 1 : 0 },
    } satisfies Storage
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })

    saveInstructionQueue([localInstruction()])
    const restored = loadInstructionQueue()

    expect(writes).toBe(2)
    expect(restored[0].submissionState).toBe("failed")
    expect(restored[0].submissionError).toContain("重新选择附件")
    expect(restored[0].attachments[0].dataBase64).toBeUndefined()
  })

  test("upgrades legacy queue entries without a server state to local admission", () => {
    let stored = JSON.stringify([{ ...localInstruction(), serverState: undefined }])
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value },
      removeItem: () => { stored = "" },
      clear: () => { stored = "" },
      key: () => null,
      get length() { return stored ? 1 : 0 },
    } satisfies Storage
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })

    expect(loadInstructionQueue()[0].serverState).toBe("local")
  })
})

function localInstruction(): QueuedInstruction {
  return {
    id: "large-local",
    requestId: "large-local",
    sessionId: "session-local",
    text: "分析附件",
    attachments: [{
      name: "large.bin",
      path: "C:\\selected\\large.bin",
      size: 12 * 1024 * 1024,
      mime: "application/octet-stream",
      kind: "binary",
      dataBase64: "AQID",
    }],
    scope: "auto-edit",
    effort: "on",
    modelId: null,
    workingDir: null,
    serverState: "local",
    createdAt: 1,
  }
}
