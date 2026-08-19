import { describe, expect, test } from "bun:test"
import type { MessageRow } from "../src/store/repository.ts"
import type { ModelConfig } from "../src/model-router/types.ts"
import {
  assessContextPressure,
  buildAgentHistory,
  chooseRowsToCompact,
  contextInputBudget,
  parseCompactSummary,
  PROTOCOL_MESSAGE_LIMIT,
  trimHistoryToCapacity,
  trimHistoryToBudget,
  unsummarizedRows,
} from "../src/runtime/context-compaction.ts"
import { estimateProjectedHistoryTokens } from "../src/runtime/llm-client.ts"

function row(seq: number, content: string, timestamp = seq * 1_000): MessageRow {
  return {
    id: `message-${seq}`,
    session_id: "session-1",
    role: seq % 2 ? "user" : "assistant",
    content,
    agent_id: null,
    tool_calls: null,
    tool_results: null,
    seq,
    timestamp,
  }
}

describe("context compaction budget", () => {
  test("projects foreign tool history before assessing compaction pressure", () => {
    const model: ModelConfig = {
      id: "reasoning-model",
      name: "Reasoning model",
      provider: "openai-compatible",
      modelId: "reasoning-model",
      capabilities: ["reasoning", "chat"],
      priority: 100,
      costFactor: 1,
      enabled: true,
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
    }
    const largePayload = "x".repeat(80_000)
    const history = [{
      role: "assistant",
      content: "",
      originModelId: "foreign-model",
      toolCalls: [{ id: "call-1", name: "schematic_read", arguments: { payload: largePayload } }],
      toolResults: [{ id: "call-1", result: largePayload }],
    }]

    const raw = assessContextPressure({
      history,
      incoming: "继续审查",
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      overheadTokens: 2_048,
    })
    const projectedTokens = estimateProjectedHistoryTokens(model, history)
    const projected = assessContextPressure({
      history,
      incoming: "继续审查",
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      overheadTokens: 2_048,
      projectedHistoryTokens: projectedTokens,
    })

    expect(projectedTokens).toBeLessThan(raw.breakdown.messages / 10)
    expect(projected.estimatedTokens).toBeLessThan(raw.estimatedTokens / 10)
  })

  test("reserves output tokens and a safety margin", () => {
    expect(contextInputBudget(16_384, 4_096)).toBe(11_469)
    expect(contextInputBudget(8_192, 20_000)).toBe(1_024)
  })

  test("reports warning and compaction pressure at configured thresholds", () => {
    const warning = assessContextPressure({
      history: [{ role: "user", content: "x".repeat(9_500) }],
      incoming: "next",
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      overheadTokens: 1_000,
    })
    const compact = assessContextPressure({
      history: [{ role: "user", content: "x".repeat(11_000) }],
      incoming: "next",
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      overheadTokens: 1_000,
    })
    expect(warning.level).toBe("warning")
    expect(compact.level).toBe("compact")
  })

  test("treats protocol message cardinality as an independent capacity dimension", () => {
    const pressure = assessContextPressure({
      history: Array.from({ length: 420 }, () => ({ role: "user" as const, content: "x" })),
      incoming: "next",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      overheadTokens: 2_048,
      projectedHistoryMessages: 420,
    })
    expect(pressure.tokenRatio).toBeLessThan(0.01)
    expect(pressure.messageRatio).toBeGreaterThan(0.8)
    expect(pressure.limitingFactor).toBe("messages")
    expect(pressure.level).toBe("compact")
    expect(pressure.messageLimit).toBe(PROTOCOL_MESSAGE_LIMIT)
  })
})

describe("context compaction history", () => {
  test("restores completed persisted tool transactions before the final conclusion", () => {
    const toolRow = row(2, "最终结论")
    toolRow.tool_calls = JSON.stringify([
      {
        id: "call-1",
        name: "read",
        input: { path: "a.c" },
        round: 1,
        reasoningContent: "reason-1",
        reasoningDetails: [{ type: "reasoning.text", text: "reason-1" }],
        originModelId: "deepseek",
      },
      { id: "call-2", name: "edit", input: { path: "a.c" }, round: 2, reasoningContent: "reason-2", originModelId: "deepseek" },
    ])
    toolRow.tool_results = JSON.stringify([
      { id: "call-1", name: "read", result: "old", round: 1 },
      { id: "call-2", name: "edit", result: "done", round: 2 },
    ])
    const history = buildAgentHistory([toolRow], null)
    expect(history).toHaveLength(5)
    expect(history[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "read", input: { path: "a.c" } }],
      reasoningContent: "reason-1",
      originModelId: "deepseek",
    })
    expect(history[1]).toMatchObject({
      role: "tool",
      toolResults: [{ id: "call-1", name: "read", result: "old" }],
    })
    expect(history[2]?.toolCalls?.[0]).toMatchObject({ id: "call-2", name: "edit" })
    expect(history[3]?.toolResults?.[0]).toMatchObject({ id: "call-2", result: "done" })
    expect(history[4]).toEqual({ role: "assistant", content: "最终结论" })
  })

  test("keeps replayed high-round tool history bounded to the newest complete pairs", () => {
    const toolRow = row(2, "完成结论")
    toolRow.tool_calls = JSON.stringify(Array.from({ length: 600 }, (_, index) => ({
      id: `call-${index}`,
      name: index % 2 ? "read" : "grep",
      input: { path: `secret-${index}.c` },
      round: index,
    })))
    toolRow.tool_results = JSON.stringify(Array.from({ length: 600 }, (_, index) => ({
      id: `call-${index}`,
      name: index % 2 ? "read" : "grep",
      result: `evidence-${index}`,
      round: index,
    })))
    const history = buildAgentHistory([toolRow], null)
    expect(history).toHaveLength(49)
    expect(history[0]?.toolCalls?.[0]).toMatchObject({ id: "call-576" })
    expect(history[47]?.toolResults?.[0]).toMatchObject({ id: "call-599", result: "evidence-599" })
    expect(history[48]).toEqual({ role: "assistant", content: "完成结论" })
    expect(JSON.stringify(history)).not.toContain("call-575")
    expect(JSON.stringify(history).length).toBeLessThan(30_000)
  })

  test("omits historical tool protocol when no public conclusion exists", () => {
    const toolRow = row(2, "")
    toolRow.tool_calls = JSON.stringify([
      { id: "call-missing", name: "bash", input: { command: "python secret-script.py" } },
    ])
    const history = buildAgentHistory([toolRow], null)
    expect(history).toHaveLength(0)
  })

  test("removes a legacy audit appendix before replaying a public conclusion", () => {
    const toolRow = row(2, [
      "构建尚未完成，需要重新执行。",
      "已执行操作类型：edit、bash、read。",
      '- bash: {"error":"工具调用被拒绝: 工具不在 Agent 当前白名单中"}',
      "历史工具协议不参与新运行；依赖当前状态的结论必须重新核验。",
    ].join("\n"))
    toolRow.tool_calls = JSON.stringify([{ id: "call-1", name: "read" }])
    toolRow.tool_results = JSON.stringify([{ id: "call-1", name: "read", result: "secret" }])
    const history = buildAgentHistory([toolRow], null)
    expect(history).toHaveLength(3)
    expect(history[1]?.toolResults?.[0]).toMatchObject({ name: "read", result: "secret" })
    expect(history[2]).toEqual({ role: "assistant", content: "构建尚未完成，需要重新执行。" })
  })

  test("restores direct document extraction while keeping orchestration records private", () => {
    const toolRow = row(2, "任务仍需继续写入核对报告。")
    toolRow.tool_calls = JSON.stringify([
      { id: "read-docx", name: "read", input: { paths: ["report.docx"] }, round: 1 },
      { id: "todo-private", name: "todowrite", input: { todos: [] }, round: 2 },
    ])
    toolRow.tool_results = JSON.stringify([
      { id: "read-docx", name: "read", result: "[DOCX]\n# Direct title\n## Summary", round: 1 },
      { id: "todo-private", name: "todowrite", result: "internal", round: 2 },
    ])

    const history = buildAgentHistory([toolRow], null)
    expect(history).toHaveLength(3)
    expect(history[0]?.toolCalls?.[0]).toMatchObject({ id: "read-docx", name: "read" })
    expect(history[1]?.toolResults?.[0]?.result).toContain("Direct title")
    expect(JSON.stringify(history)).not.toContain("todo-private")
    expect(history[2]?.content).toContain("继续写入")
  })

  test("uses throughSeq so summarized messages are not injected twice", () => {
    const rows = [row(1, "old request"), row(2, "old answer"), row(3, "recent request"), row(4, "recent answer")]
    const session = {
      compact_summary: JSON.stringify({ content: "old work summary", timestamp: 2_500, throughSeq: 2, mode: "auto" }),
      compact_at: 2_500,
    }
    const summary = parseCompactSummary(session)
    expect(unsummarizedRows(rows, summary).map((item) => item.seq)).toEqual([3, 4])
    const history = buildAgentHistory(rows, summary)
    expect(history).toHaveLength(3)
    expect(history[0].content).toContain("old work summary")
    expect(history.some((item) => item.content === "old request")).toBe(false)
  })

  test("supports legacy summaries by using their timestamp", () => {
    const rows = [row(1, "before", 1_000), row(2, "after", 3_000)]
    const summary = parseCompactSummary({
      compact_summary: JSON.stringify({ content: "legacy", timestamp: 2_000 }),
      compact_at: 2_000,
    })
    expect(unsummarizedRows(rows, summary).map((item) => item.content)).toEqual(["after"])
  })

  test("keeps recent messages and always leaves something to continue from", () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(index + 1, `message ${index + 1} ${"x".repeat(600)}`))
    const split = chooseRowsToCompact(rows, 4_000)
    expect(split.compact.length).toBeGreaterThan(0)
    expect(split.keep.length).toBeGreaterThan(0)
    expect(split.keep.at(-1)?.seq).toBe(10)
  })

  test("safe trimming preserves the compact summary and newest message", () => {
    const history = [
      { role: "user" as const, content: "[早期对话压缩摘要]\nimportant decision" },
      { role: "assistant" as const, content: "x".repeat(4_000) },
      { role: "user" as const, content: "latest request" },
    ]
    const trimmed = trimHistoryToBudget(history, 500)
    expect(trimmed[0].content).toContain("important decision")
    expect(trimmed.at(-1)?.content).toBe("latest request")
  })

  test("safe trimming also enforces the protocol message budget", () => {
    const history = [
      { role: "user" as const, content: "[早期对话压缩摘要]\nimportant decision" },
      ...Array.from({ length: 600 }, (_, index) => ({
        role: (index % 2 ? "assistant" : "user") as "assistant" | "user",
        content: `message-${index}`,
      })),
    ]
    const trimmed = trimHistoryToCapacity(history, 100_000, 128)
    expect(trimmed.length).toBeLessThanOrEqual(128)
    expect(trimmed[0].content).toContain("important decision")
    expect(trimmed.at(-1)?.content).toBe("message-599")
  })
})
