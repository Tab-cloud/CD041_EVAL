import { describe, expect, test } from "bun:test"
import { MainAgentMessageAccumulator } from "../src/runtime/main-agent-message"
import {
  isDurableRunEvent,
  publicToolRecords,
} from "../src/runtime/server-chat"
import { projectPublicRunEvent } from "../src/runtime/public-run-event.ts"
import { PublicAgentEventForwarder } from "../src/runtime/server-chat-public-events.ts"

describe("main Agent public delivery boundary", () => {
  test("tool-round text is excluded from the durable assistant message", () => {
    const ledger = new MainAgentMessageAccumulator()
    ledger.observeText(0, 0, "正在读取内部文件")
    ledger.observeToolCall(0, 0)

    ledger.finishRound(0, 0)
    expect(ledger.delivery()).toBe("")
  })

  test("a finished no-tool round becomes the durable assistant message", () => {
    const ledger = new MainAgentMessageAccumulator()
    ledger.observeText(0, 1, "任务已经完成。")

    ledger.finishRound(0, 1)
    expect(ledger.delivery()).toBe("任务已经完成。")
  })

  test("normalized text may arrive after finish without becoming a presentation gate", () => {
    const ledger = new MainAgentMessageAccumulator()

    ledger.finishRound(0, 3)
    ledger.observeText(0, 3, "最终交付")
    ledger.observeText(0, 3, "")
    ledger.finishRound(0, 3)
    expect(ledger.delivery()).toBe("最终交付")
  })

  test("a tool observed between provider finish and text keeps the round internal", () => {
    const ledger = new MainAgentMessageAccumulator()

    ledger.finishRound(0, 4)
    ledger.observeToolCall(0, 4)
    ledger.observeText(0, 4, "正在调用内部工具")
    expect(ledger.delivery()).toBe("")
  })

  test("text from an unfinished failed round is not a delivery", () => {
    const ledger = new MainAgentMessageAccumulator()
    ledger.observeText(0, 2, "尚未完成的半截回复")

    expect(ledger.delivery()).toBe("")
  })
})

test("all semantic public events share the durable replay channel", () => {
  for (const type of ["assistant-part", "agent-progress", "plan-submitted"] as const) {
    expect(isDurableRunEvent(type)).toBe(true)
  }
  expect(projectPublicRunEvent("assistant-part", {
    requestId: "request-1", partId: "reasoning:1", partType: "reasoning",
    status: "delta", text: "检查输入参数", timestamp: 10,
  })).toEqual({
    type: "assistant-part",
    payload: {
      requestId: "request-1", partId: "reasoning:1", partType: "reasoning",
      status: "delta", text: "检查输入参数", timestamp: 10,
    },
  })
  expect(isDurableRunEvent("heartbeat")).toBe(false)
})

test("root-model reasoning is streamed through the public boundary while internal details are redacted", () => {
  const events: Array<{ type: string; payload: any }> = []
  const forwarder = new PublicAgentEventForwarder(true)
  const input = { rootRunId: "root", emit: (type: any, payload: any) => events.push({ type, payload }) }

  forwarder.forward({ type: "thinking-start" }, input)
  forwarder.forward({ type: "thinking-delta", text: "先核对电源参数，再检查纹波。" }, input)
  forwarder.forward({ type: "thinking-delta", text: "\nrequirements-analyst-agent child-run:lease:secret" }, input)
  forwarder.forward({ type: "thinking-end" }, input)
  forwarder.forward({ type: "finish" }, input)

  expect(events.map((event) => event.type)).toEqual([
    "agent-progress", "assistant-part", "assistant-part", "assistant-part",
  ])
  expect(events.filter((event) => event.type === "assistant-part" && event.payload.status === "delta")
    .map((event) => event.payload.text).join(""))
    .toContain("先核对电源参数")
  expect(JSON.stringify(events)).not.toContain("requirements-analyst-agent")
  expect(JSON.stringify(events)).not.toContain("child-run:lease:secret")
})

test("a root model attempt owns server-timed reasoning and live text parts", () => {
  const events: Array<{ type: string; payload: any }> = []
  const forwarder = new PublicAgentEventForwarder(true)
  const input = { rootRunId: "root", emit: (type: any, payload: any) => events.push({ type, payload }) }

  forwarder.forward({
    type: "model-attempt", scope: "agent", status: "running",
    attemptId: "attempt-1", operation: "chat", segment: 0, step: 0,
    attempt: 1, modelId: "minimax-m3", modelName: "MiniMax M3",
  }, input)
  const reasoningStart = events.find((event) => event.type === "assistant-part" && event.payload.partType === "reasoning")
  expect(reasoningStart?.payload).toMatchObject({ status: "start", partId: "reasoning:attempt-1:0" })

  forwarder.forward({ type: "text-delta", text: "first chunk", _step: 0 }, input)
  expect(events.filter((event) => event.type === "assistant-part" && event.payload.partType === "text")
    .map((event) => event.payload.status)).toEqual(["start", "delta"])

  forwarder.forward({ type: "finish", _step: 0 }, input)
  expect(events.filter((event) => event.type === "assistant-part" && event.payload.status === "end")
    .map((event) => event.payload.partType)).toEqual(["reasoning", "text"])
})

test("tool selection discards provisional narration without closing reasoning", () => {
  const events: Array<{ type: string; payload: any }> = []
  const forwarder = new PublicAgentEventForwarder(true)
  const input = { rootRunId: "root", emit: (type: any, payload: any) => events.push({ type, payload }) }
  forwarder.forward({ type: "thinking-start", _step: 0 }, input)
  forwarder.forward({ type: "text-delta", text: "I will inspect it", _step: 0 }, input)

  forwarder.discardText(input)

  expect(events.find((event) => event.payload.partType === "text" && event.payload.status === "end")?.payload.outcome)
    .toBe("discarded")
  expect(events.find((event) => event.payload.partType === "reasoning" && event.payload.status === "end"))
    .toBeUndefined()
})

test("durable conversation history hides the same orchestration tools as live SSE", () => {
  const records = publicToolRecords([
    { name: "task", result: "child details" },
    { name: "delegate_dag", result: "internal graph" },
    { name: "todowrite", result: "internal plan" },
    { name: "compile", result: "public build result" },
  ])

  expect(records).toEqual([
    { name: "compile", result: "public build result" },
  ])
})
