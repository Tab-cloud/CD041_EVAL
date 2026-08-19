import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { ModelRouter } from "../src/model-router/index.ts"
import type { ModelConfig } from "../src/model-router/types.ts"
import {
  classifyNativeToolProtocolFailure,
  observeNativeToolProtocolFailure,
  observeNativeToolProtocolSuccess,
} from "../src/runtime/model-protocol-observation.ts"
import { resolveProtocolExecutorModelIds } from "../src/runtime/server-chat-policy.ts"
import {
  ModelProtocolCapabilityRepo,
  modelProtocolIdentity,
} from "../src/store/model-protocol-capability.ts"
import { handleTestConnection } from "../src/runtime/server-test-connection.ts"

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  const suffix = randomUUID()
  return {
    id: `config-${suffix}`,
    name: `Model ${suffix}`,
    provider: "openai-compatible",
    modelId: `model-${suffix}`,
    apiKey: "test",
    baseUrl: `https://gateway-${suffix}.example/v1`,
    capabilities: ["reasoning", "coding", "chat"],
    priority: 50,
    costFactor: 1,
    enabled: true,
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
    ...overrides,
  }
}

describe("native tool protocol evidence arbitration", () => {
  test("connection testing reports one protocol miss as unknown, then requires an independent confirmation", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const chunk = {
          choices: [{
            delta: { content: "mock model" },
            finish_reason: "stop",
          }],
        }
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const body = {
      modelId: `connection-${randomUUID()}`,
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: "test",
    }
    const testOnce = async () => {
      const response = await handleTestConnection(new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify(body),
      }), {}, null)
      return response.json() as Promise<{
        ok: boolean
        toolProtocol: { status: "verified" | "unsupported" | "unknown" }
      }>
    }
    try {
      expect(await testOnce()).toMatchObject({
        ok: true,
        toolProtocol: { status: "unknown" },
      })
      expect(await testOnce()).toMatchObject({
        ok: true,
        toolProtocol: { status: "unsupported" },
      })
    } finally {
      server.stop(true)
    }
  })

  test("one forced-tool miss cannot quarantine a previously verified model", () => {
    const target = model()
    observeNativeToolProtocolSuccess(target, "probe:success")

    observeNativeToolProtocolFailure({
      model: target,
      scope: "run-a:step-1",
      reason: "模型完成了 required 回合但没有返回工具事件",
      completedWithoutToolCall: true,
    })

    expect(ModelProtocolCapabilityRepo.status(target)).toBe("verified")
    expect(ModelProtocolCapabilityRepo.observations(target).map((item) => item.kind))
      .toEqual(["conclusive-failure", "verified"])
  })

  test("only distinct conclusive observation scopes can quarantine a model", () => {
    const target = model()
    const miss = (scope: string) => observeNativeToolProtocolFailure({
      model: target,
      scope,
      reason: "forced tool call completed without a native event",
      completedWithoutToolCall: true,
    })

    miss("run-a:step-1")
    miss("run-a:step-1")
    expect(ModelProtocolCapabilityRepo.status(target)).toBe("unknown")
    expect(ModelProtocolCapabilityRepo.observations(target)).toHaveLength(1)

    miss("run-b:step-1")
    expect(ModelProtocolCapabilityRepo.status(target)).toBe("unsupported")
  })

  test("a successful retry supersedes a failure in the same observation scope", () => {
    const target = model()
    observeNativeToolProtocolFailure({
      model: target,
      scope: "run-a:step-1",
      reason: "required turn completed without a native event",
      completedWithoutToolCall: true,
    })
    observeNativeToolProtocolSuccess(target, "run-a:step-1")

    expect(ModelProtocolCapabilityRepo.status(target)).toBe("verified")
    expect(ModelProtocolCapabilityRepo.observations(target)).toMatchObject([{
      scope: "run-a:step-1",
      kind: "verified",
    }])
  })

  test("network, quota, cancellation and generic request errors remain transient", () => {
    const target = model()
    observeNativeToolProtocolSuccess(target, "probe:success")
    const reasons = [
      "HTTP 429 rate limit exceeded",
      "AccountQuotaExceeded: 配额已耗尽",
      "request timeout after 120000ms",
      "用户取消了任务",
      "HTTP 400 max_output_tokens is too large",
    ]
    reasons.forEach((reason, index) => {
      expect(observeNativeToolProtocolFailure({
        model: target,
        scope: `transient:${index}`,
        reason,
      })).toBe("transient")
    })

    expect(ModelProtocolCapabilityRepo.status(target)).toBe("verified")
    expect(ModelProtocolCapabilityRepo.observations(target)
      .filter((item) => item.kind === "transient-failure")).toHaveLength(reasons.length)
  })

  test("an explicit provider rejection of tool_choice is conclusive evidence", () => {
    expect(classifyNativeToolProtocolFailure({
      reason: "HTTP 400: unknown parameter tool_choice; tools are not supported",
    })).toBe("conclusive")
    expect(classifyNativeToolProtocolFailure({
      reason: "HTTP 500 while processing tool_choice",
    })).toBe("transient")
  })

  test("wire identity is normalized and kept separate from public model selection", () => {
    const conversation = model({
      id: "conversation-config",
      modelId: "shared-wire-model",
      baseUrl: "HTTPS://GATEWAY.EXAMPLE/V1/",
    })
    const duplicateWireExecutor = model({
      id: "duplicate-config",
      modelId: "shared-wire-model",
      baseUrl: "https://gateway.example/v1",
    })
    const realExecutor = model({
      id: "executor-config",
      modelId: "native-executor",
      baseUrl: "https://executor.example/v1",
    })
    const router = new ModelRouter([
      conversation,
      duplicateWireExecutor,
      realExecutor,
    ])
    const selected = router.getModel("conversation-config")!
    const duplicate = router.getModel("duplicate-config")!
    const executor = router.getModel("executor-config")!

    expect(modelProtocolIdentity(selected)).toBe(modelProtocolIdentity(duplicate))
    expect(modelProtocolIdentity(selected)).not.toBe(modelProtocolIdentity({
      ...duplicate,
      apiKey: "different-account",
    }))
    expect(resolveProtocolExecutorModelIds(
      router,
      selected.id,
      ["reasoning", "coding", "chat"],
      {
        primaryModelId: duplicate.id,
        fallbackModelIds: [executor.id],
      },
    )).toEqual([executor.id])

    observeNativeToolProtocolSuccess(selected, "conversation:verified")
    for (const scope of ["executor:miss-1", "executor:miss-2"]) {
      observeNativeToolProtocolFailure({
        model: executor,
        scope,
        reason: "required turn completed without a native event",
        completedWithoutToolCall: true,
      })
    }
    expect(ModelProtocolCapabilityRepo.status(selected)).toBe("verified")
    expect(ModelProtocolCapabilityRepo.status(executor)).toBe("unsupported")
    expect(resolveProtocolExecutorModelIds(
      router,
      selected.id,
      ["reasoning", "coding", "chat"],
      {
        primaryModelId: executor.id,
        fallbackModelIds: [duplicate.id],
      },
    )).toEqual([])
  })
})
