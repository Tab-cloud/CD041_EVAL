import { describe, expect, test } from "bun:test"
import { clearSessionConversation } from "../src/session-clear"

describe("session clear transport", () => {
  test("waits for lifecycle completion instead of treating HTTP 202 as cleared", async () => {
    const statuses = [202, 200]
    const waits: number[] = []
    const result = await clearSessionConversation("session-a", {
      fetcher: async () => {
        const status = statuses.shift() ?? 500
        return Response.json(
          status === 202
            ? { success: false, terminating: true }
            : { success: true, artifactRevision: 7 },
          { status },
        )
      },
      wait: async (milliseconds) => { waits.push(milliseconds) },
    })

    expect(result).toEqual({ success: true, artifactRevision: 7 })
    expect(waits).toEqual([250])
  })

  test("keeps the failure visible when durable context was not cleared", async () => {
    expect(clearSessionConversation("session-a", {
      fetcher: async () => Response.json({ error: "cleanup failed" }, { status: 500 }),
    })).rejects.toThrow("cleanup failed")
  })

  test("clears stale optimistic UI when no durable session exists", async () => {
    const result = await clearSessionConversation("missing-session", {
      fetcher: async () => Response.json({ error: "会话不存在" }, { status: 404 }),
    })
    expect(result).toEqual({ success: true, artifactRevision: 0 })
  })

  test("does not report success while termination remains pending", async () => {
    expect(clearSessionConversation("session-a", {
      maxAttempts: 2,
      retryDelayMs: 0,
      fetcher: async () => Response.json({ success: false, terminating: true }, { status: 202 }),
      wait: async () => undefined,
    })).rejects.toThrow("仍在结束当前任务")
  })
})
