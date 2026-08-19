import { describe, expect, test } from "bun:test"
import {
  activityEntryLabel,
  activityWindow,
  buildActivityHeadline,
} from "../src/agent-activity-feed"
import type { WorkLogEntry } from "../src/store"

function entry(
  id: string,
  type: WorkLogEntry["type"],
  status: WorkLogEntry["status"] = "done",
  overrides: Partial<WorkLogEntry> = {},
): WorkLogEntry {
  return {
    id,
    type,
    status,
    label: type === "edit" ? "编辑文件" : type === "execute" ? "执行命令" : "读取文件",
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    ...overrides,
  }
}

describe("agent activity feed", () => {
  test("summarizes completed work into a compact user-facing headline", () => {
    const headline = buildActivityHeadline({
      entries: [
        entry("1", "edit", "done", { fileName: "index.tsx" }),
        entry("2", "edit", "done", { fileName: "index.tsx" }),
        entry("3", "execute"),
        entry("4", "search"),
      ],
      isStreaming: false,
    })

    expect(headline).toEqual({
      text: "编辑了 1 个文件 · 运行了 1 个命令 · 查阅了 1 项资料",
      tone: "complete",
    })
  })

  test("reconnection is the primary activity while transport is recovering", () => {
    expect(buildActivityHeadline({
      entries: [entry("1", "edit", "running")],
      isStreaming: true,
      activeLabel: "正在编辑文件",
      connectionStatus: "connecting",
      reconnectAttempt: 2,
    })).toEqual({ text: "正在重新连接 · 第 2 次", tone: "reconnecting" })
  })

  test("initial request connection does not masquerade as a reconnect", () => {
    expect(buildActivityHeadline({
      entries: [],
      isStreaming: true,
      activeLabel: "等待主 Agent 调度",
      connectionStatus: "connecting",
      reconnectAttempt: 0,
    })).toEqual({ text: "等待主 Agent 调度", tone: "active" })
  })

  test("unresolved failed steps cannot be hidden by completed steps", () => {
    expect(buildActivityHeadline({
      entries: [entry("1", "search"), entry("2", "execute", "error")],
      isStreaming: false,
    })).toEqual({ text: "完成 1 项 · 1 项需要处理", tone: "error" })
  })

  test("recovered tool attempts stay out of the user-facing error summary and activity list", () => {
    const recovered = entry("2", "execute", "error", { recovered: true })
    expect(buildActivityHeadline({
      entries: [entry("1", "search"), recovered],
      isStreaming: false,
    })).toEqual({ text: "查阅了 1 项资料", tone: "complete" })
    expect(activityWindow([entry("1", "search"), recovered]).visible.map((item) => item.id))
      .toEqual(["1"])
  })

  test("keeps the latest activity visible and exposes older history separately", () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry(String(index + 1), "search"))
    const window = activityWindow(entries, 4)
    expect(window.hidden.map((item) => item.id)).toEqual(["1", "2", "3", "4", "5", "6"])
    expect(window.visible.map((item) => item.id)).toEqual(["7", "8", "9", "10"])
  })

  test("uses natural stateful labels for activity rows", () => {
    expect(activityEntryLabel(entry("1", "edit", "running"))).toBe("正在编辑")
    expect(activityEntryLabel(entry("2", "search", "done", { label: "读取文件" }))).toBe("已读取")
    expect(activityEntryLabel(entry("3", "execute", "error", { label: "编译项目" }))).toBe("编译失败")
  })
})
