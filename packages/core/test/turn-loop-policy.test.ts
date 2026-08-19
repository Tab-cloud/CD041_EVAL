import { expect, test } from "bun:test"
import { LightweightTurnLoopPolicy } from "../src/runtime/turn-loop-policy.ts"

test("native tool calls always continue as tool transactions", () => {
  const policy = new LightweightTurnLoopPolicy()
  expect(policy.decide({ nativeToolCallCount: 2, finishReason: "stop" }))
    .toEqual({ type: "execute-tools" })
})

test("output limits continue while ordinary model finishes complete", () => {
  const policy = new LightweightTurnLoopPolicy()
  expect(policy.decide({ nativeToolCallCount: 0, finishReason: "length" }))
    .toEqual({ type: "continue-output" })
  expect(policy.decide({ nativeToolCallCount: 0, finishReason: "stop" }))
    .toEqual({ type: "complete" })
})
