import { describe, expect, test } from "bun:test"
import type { ExecutionSnapshot } from "../src/runtime/agent-loop-control.ts"
import { resolveContinuationResources } from "../src/runtime/server-chat-continuation.ts"
import type { SessionCommandView } from "../src/store/session-command.ts"

function snapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    state: "failed",
    todos: [],
    segment: 1,
    idleTurns: 0,
    toolRounds: 0,
    limit: 5,
    consecutiveNoProgress: 0,
    updatedAt: 1,
    ...overrides,
  }
}

function command(requestId: string, name: string): SessionCommandView {
  return {
    requestId,
    sessionId: "session-1",
    sessionSeq: 1,
    payload: JSON.stringify({
      message: "阅读附件",
      attachments: [{
        name,
        mime: "application/pdf",
        kind: "binary",
        dataBase64: "ZGF0YQ==",
      }],
    }),
    state: "failed",
    createdAt: 1,
  }
}

describe("continuation resource ownership", () => {
  test("restores an exact immutable command resource referenced by the snapshot", async () => {
    const source = command("request-source", "report.pdf")
    const result = await resolveContinuationResources({
      currentAttachments: [],
      currentRequestId: "request-continue",
      sessionId: "session-1",
      workingDir: "C:/workspace",
      snapshot: snapshot({ resourceRequestIds: ["request-source"] }),
      dependencies: {
        getTask: () => null,
        getCommand: (requestId) => requestId === source.requestId ? source : null,
        listCommands: () => [],
        process: async (raw) => raw.map((item) => ({
          name: item.name,
          mime: item.mime,
          kind: "text" as const,
          content: "extracted report",
        })),
      },
    })

    expect(result.requestIds).toEqual(["request-source"])
    expect(result.sourceMessage).toBe("阅读附件")
    expect(result.attachments).toEqual([{
      name: "report.pdf",
      mime: "application/pdf",
      kind: "text",
      content: "extracted report",
    }])
  })

  test("migrates a legacy snapshot only from matching resources in the same session", async () => {
    const source = command("request-source", "KimiK3技术报告.pdf")
    const unrelated = command("request-unrelated", "other.pdf")
    const result = await resolveContinuationResources({
      currentAttachments: [],
      currentRequestId: "request-continue",
      sessionId: "session-1",
      workingDir: "C:/workspace",
      snapshot: snapshot({
        objectiveEvidenceBindings: [{
          requirementId: "doc-summary",
          kind: "source-inspection",
          targets: ["**/*.pdf"],
          globalVerification: false,
          source: "legacy",
        }],
      }),
      dependencies: {
        getTask: () => null,
        getCommand: () => null,
        // Repository order is newest-first; the most recent attachment-bearing
        // command belongs to the objective being continued.
        listCommands: () => [source, unrelated],
        process: async (raw) => raw.map((item) => ({
          name: item.name,
          mime: item.mime,
          kind: "text" as const,
          content: "legacy extracted report",
        })),
      },
    })

    expect(result.requestIds).toEqual(["request-source"])
    expect(result.attachments[0]?.name).toBe("KimiK3技术报告.pdf")
    expect(result.sourceMessage).toBe("阅读附件")
  })
})
