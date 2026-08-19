import { describe, expect, test } from "bun:test"
import { isDeliveredCompletion, resolveTerminalDelivery } from "../src/terminal-delivery"

describe("terminal delivery contract", () => {
  test("does not invent a completion message for an empty completed event", () => {
    const text = resolveTerminalDelivery("", { status: "completed", result: "" })
    expect(text).toBe("")
    expect(isDeliveredCompletion({ status: "completed" }, text)).toBe(false)
  })

  test("accepts only streamed or explicit runtime delivery", () => {
    expect(resolveTerminalDelivery("已完成真实验证", { status: "completed" }))
      .toBe("已完成真实验证")
    expect(resolveTerminalDelivery("", {
      status: "failed",
      problem: { message: "任务执行遇到问题，主 Agent 已保留诊断信息。" },
    })).toBe("任务执行遇到问题，主 Agent 已保留诊断信息。")
  })
})
