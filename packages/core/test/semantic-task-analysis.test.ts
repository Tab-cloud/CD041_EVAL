import { afterEach, describe, expect, test } from "bun:test"
import { AgentRegistry } from "../src/agent/registry.ts"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { AgentLoop } from "../src/runtime/agent-loop.ts"
import { ModelRouter } from "../src/model-router/index.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import { EMBEDDED_TOOLS } from "../src/tool/tools-index.ts"
import {
  AgentOrchestrator,
  SemanticAgentResolutionError,
} from "../src/runtime/orchestrator.ts"
import {
  compileObjective,
  StructuredObjectiveIntentRequiredError,
  type StructuredObjectiveIntent,
} from "../src/runtime/objective-compiler.ts"
import { selectRuntimeAgent } from "../src/runtime/runtime-agent-selection.ts"
import {
  analyzeSemanticTask,
  bindSemanticTaskResources,
  parseSemanticTaskAnalysis,
  SemanticTaskAnalysisUnavailableError,
  type SemanticTaskAnalysis,
} from "../src/runtime/semantic-task-analysis.ts"
import {
  constrainSemanticAnalysisForTurn,
  resolveRootAgentRouting,
} from "../src/runtime/server-chat-semantic-routing.ts"
import { handleChat } from "../src/runtime/server-chat.ts"
import { SESSION_COMMAND_PROCESS_EPOCH } from "../src/runtime/session-command-queue.ts"
import { normalizeSystemSettings } from "../src/runtime/system-settings.ts"
import { SessionCommandRepo } from "../src/store/session-command.ts"
import { TaskRunRepo } from "../src/store/task-run.ts"
import { MessageRepo, SessionRepo } from "../src/store/repository.ts"
import { OrchestrationLogRepo } from "../src/store/orchestration-log.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  while (servers.length) servers.pop()!.stop(true)
})

describe("structured semantic task analysis", () => {
  test("document attachments bind targetless inspection to the admitted resource", () => {
    const parsed = parseSemanticTaskAnalysis(JSON.stringify({
      goalType: "documentation",
      complexity: "simple",
      requiredEffects: ["workspace-read"],
      candidateAgentIds: ["explore"],
      requiresPlanning: false,
    }), new Set(["explore"]))

    const bound = bindSemanticTaskResources(parsed, [{
      name: "KimiK3技术报告.pdf",
      mime: "application/pdf",
      kind: "text",
    }])

    expect(bound.acceptanceRequirements).toEqual([{
      id: "runtime-workspace-inspection",
      label: expect.any(String),
      verifier: "workspace-inspection",
      anyOf: ["workspace-inspection"],
      targetPatterns: ["kimik3技术报告.pdf"],
    }])
  })

  test("paraphrases, pinyin and vocabulary-free requests use one semantic protocol", async () => {
    const requests: string[] = []
    const router = semanticRouter((input) => {
      requests.push(input)
      return {
        goalType: "implementation",
        complexity: "compound",
        requiredEffects: ["workspace-read"],
        candidateAgentIds: ["firmware-engineer"],
        requiresPlanning: false,
      }
    })

    const messages = [
      "把板子上负责收数据的那一层整理好，确认它确实能工作",
      "bang wo ba chuan kou na kuai nong hao, ran hou kan kan jieguo",
      "让这块设备能把采样结果稳定送出来，现有工程里处理",
    ]
    for (const [index, message] of messages.entries()) {
      const analysis = await analyzeSemanticTask({
        message,
        scope: "auto-edit",
        agents: HIDDEN_AGENTS,
        modelRouter: router,
        sessionId: `semantic-${index}`,
      })
      expect(analysis).toMatchObject({
        source: "model",
        goalType: "implementation",
        requiredEffects: ["workspace-read"],
        candidateAgentIds: ["firmware-engineer"],
        requiresPlanning: false,
      })
      expect(new AgentOrchestrator().executionAgent(analysis).id).toBe("firmware-engineer")
    }
    expect(requests).toEqual(messages)
  })

  test("multi-domain work returns ordered specialists while runtime owns acceptance", async () => {
    const router = semanticRouter(() => ({
      goalType: "implementation",
      complexity: "complex",
      requiredEffects: ["workspace-write", "process"],
      candidateAgentIds: ["firmware-engineer", "test-engineer", "doc-writer"],
      requiresPlanning: true,
    }))
    const analysis = await analyzeSemanticTask({
      message: "交付一个能运行、能自证、也能让后来的人接手的完整结果",
      scope: "full-access",
      agents: HIDDEN_AGENTS,
      modelRouter: router,
      sessionId: "semantic-multi-domain",
    })

    expect(analysis.requiredEffects).toEqual(["workspace-write", "process"])
    expect(analysis.requiresPlanning).toBe(true)
    expect(analysis.candidateAgentIds).toEqual([
      "firmware-engineer",
      "test-engineer",
      "doc-writer",
    ])
    expect(analysis.acceptanceRequirements.map((item) => item.verifier)).toEqual([
      "mutation",
      "workspace-inspection",
      "process",
    ])
  })

  test("invalid model output fails closed instead of silently becoming general", async () => {
    const router = semanticRouter(() => ({
      goalType: "build",
      complexity: "simple",
      requiredEffects: ["process"],
      candidateAgentIds: ["build-agent"],
      requiresPlanning: false,
      undocumentedField: "must be rejected",
    }))
    await expect(analyzeSemanticTask({
      message: "任意表述",
      scope: "full-access",
      agents: HIDDEN_AGENTS,
      modelRouter: router,
      sessionId: "semantic-invalid",
    })).rejects.toBeInstanceOf(SemanticTaskAnalysisUnavailableError)

    await expect(analyzeSemanticTask({
      message: "任意表述",
      scope: "full-access",
      agents: HIDDEN_AGENTS,
      modelRouter: null,
      sessionId: "semantic-no-model",
    })).rejects.toMatchObject({ code: "semantic-task-analysis-unavailable" })
  })

  test("semantic routing does not ask the model to author schematic acceptance claims", async () => {
    let calls = 0
    const router = semanticRouter(() => {
      calls++
      return {
        goalType: "hardware",
        complexity: "compound",
        requiredEffects: ["workspace-read"],
        candidateAgentIds: ["hardware-engineer"],
        requiresPlanning: false,
      }
    })

    const analysis = await analyzeSemanticTask({
      message: "请设计一个12V太阳能板逆变220V的电路",
      scope: "auto-edit",
      agents: HIDDEN_AGENTS,
      modelRouter: router,
      sessionId: "semantic-protocol-repair",
    })

    expect(calls).toBe(1)
    expect(analysis.acceptanceRequirements).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "runtime-workspace-inspection",
      verifier: "workspace-inspection",
      anyOf: ["workspace-inspection"],
    })]))
  })

  test("runtime injects immutable workspace-write evidence floors", async () => {
    let calls = 0
    const router = semanticRouter(() => {
      calls++
      return {
        goalType: "hardware",
        complexity: "compound",
        requiredEffects: ["workspace-write"],
        candidateAgentIds: ["hardware-engineer"],
        requiresPlanning: false,
      }
    })

    const analysis = await analyzeSemanticTask({
      message: "请指导设计一个电源方案，将12V太阳能板的电源逆变成220V交流电",
      scope: "auto-edit",
      agents: HIDDEN_AGENTS,
      modelRouter: router,
      sessionId: "semantic-runtime-effect-floor",
    })

    expect(calls).toBe(1)
    expect(analysis.acceptanceRequirements.map((item) => item.verifier))
      .toEqual(["mutation", "workspace-inspection"])
    expect(analysis.acceptanceRequirements.find((item) => item.verifier === "mutation"))
      .toMatchObject({
        anyOf: ["workspace-mutation"],
        targetPatterns: [],
      })
  })

  test("runtime supplies both mutation and independent verification when omitted", () => {
    const normalized = parseSemanticTaskAnalysis(JSON.stringify({
      goalType: "implementation",
      complexity: "simple",
      requiredEffects: ["workspace-write", "process"],
      candidateAgentIds: ["firmware-engineer"],
      requiresPlanning: false,
    }), new Set(["firmware-engineer"]))

    expect(normalized.acceptanceRequirements.map((item) => item.verifier))
      .toEqual(["mutation", "workspace-inspection", "process"])
  })

  test("conversation-intent advisor failure degrades to a normal main-Agent turn", async () => {
    const sessionId = `intent-command-${crypto.randomUUID()}`
    const requestId = `intent-request-${crypto.randomUUID()}`
    const payload = {
      message: "继续处理",
      sessionId,
      requestId,
      workingDir: process.cwd(),
      scope: "full-access",
      effort: "off",
    }
    SessionRepo.create({
      id: sessionId,
      title: "intent owner test",
      agent_id: "main-agent",
      project_path: null,
    })
    MessageRepo.create({
      session_id: sessionId,
      request_id: null,
      role: "assistant",
      content: "已有一个尚未完成的工作目标。",
      agent_id: "main-agent",
      tool_calls: null,
      tool_results: null,
      seq: 1,
      timestamp: Date.now(),
    })
    SessionCommandRepo.enqueue({
      requestId,
      sessionId,
      payload: JSON.stringify(payload),
    })
    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)
    const agentLoop = {
      async *run(input: Parameters<AgentLoop["run"]>[0]) {
        input.executionState?.persist({
          state: "completed",
          todos: [],
          segment: 0,
          idleTurns: 0,
          toolRounds: 0,
          limit: 4,
          consecutiveNoProgress: 0,
          runtimeObjectiveAccepted: true,
          updatedAt: Date.now(),
        })
        yield { type: "text-delta", text: "主 Agent 已接收并完成当前回合。", _step: 0 } as const
        yield { type: "finish", finishReason: "stop", usage: {}, _step: 0 } as any
      },
    } as unknown as AgentLoop
    try {
      const response = await handleChat(new Request("http://local/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-eval-command-dispatcher": SESSION_COMMAND_PROCESS_EPOCH,
        },
        body: JSON.stringify(payload),
      }), {}, {
        agentLoop,
        agentRegistry,
        toolRegistry,
        modelRouter: null,
        orchestrator: new AgentOrchestrator(() => agentRegistry.list()),
        conversationTurnResolver: async () => {
          throw new Error("intent advisor unavailable")
        },
        semanticTaskAnalyzer: async () => ({
          goalType: "general",
          complexity: "simple",
          requiredEffects: [],
          candidateAgentIds: ["general"],
          requiresPlanning: false,
          acceptanceRequirements: [],
          source: "runtime-fallback",
        } as SemanticTaskAnalysis),
      })

      expect(response.status).toBe(200)
      const sse = await response.text()
      expect(sse).toContain("主 Agent 已接收并完成当前回合")
      const task = TaskRunRepo.getByRequestId(requestId)!
      expect(SessionCommandRepo.get(requestId)).toMatchObject({ taskId: task.id, state: "completed" })
      expect(TaskRunRepo.get(task.id)).toMatchObject({
        status: "completed",
        agentId: "main-agent",
      })
      expect(OrchestrationLogRepo.list({ runId: task.id, eventType: "conversation-intent.degraded" }))
        .toEqual([expect.objectContaining({
          level: "warning",
          data: expect.objectContaining({ recoveredKind: "new-objective" }),
        })])
    } finally {
      SessionRepo.delete(sessionId)
    }
  })

  test("strict parser rejects unknown agents, effects and model-authored acceptance", () => {
    const known = new Set(["general", "test-engineer"])
    expect(() => parseSemanticTaskAnalysis(JSON.stringify({
      goalType: "general",
      complexity: "simple",
      requiredEffects: [],
      candidateAgentIds: ["invented-agent"],
      requiresPlanning: false,
    }), known)).toThrow("未知或不可委派")

    expect(() => parseSemanticTaskAnalysis(JSON.stringify({
      goalType: "general",
      complexity: "simple",
      requiredEffects: ["root-shell"],
      candidateAgentIds: ["general"],
      requiresPlanning: false,
    }), known)).toThrow("未知工具效果")

    expect(() => parseSemanticTaskAnalysis(JSON.stringify({
      goalType: "general",
      complexity: "simple",
      requiredEffects: ["process"],
      candidateAgentIds: ["general"],
      requiresPlanning: false,
      acceptanceRequirements: [{
        id: "fake",
        label: "模型不能提交验收合同",
        anyOf: ["build-success", "source-inspection"],
        targetPatterns: [],
      }],
    }), known)).toThrow("未知 [acceptanceRequirements]")
  })

  test("the orchestrator cannot downgrade an invalid structured assignment to general", () => {
    const invalid: SemanticTaskAnalysis = {
      goalType: "general",
      complexity: "simple",
      requiredEffects: [],
      candidateAgentIds: [],
      requiresPlanning: false,
      acceptanceRequirements: [],
      source: "model",
    }
    expect(() => new AgentOrchestrator().executionAgent(invalid))
      .toThrow(SemanticAgentResolutionError)
  })

  test("objective compiler never derives effects or acceptance from prose", () => {
    expect(() => compileObjective(
      "修改、编译、烧录，这些词不能再触发权限",
      "full-access",
    )).toThrow(StructuredObjectiveIntentRequiredError)

    const informational = compileObjective(
      "即使原文写了修改、编译、烧录",
      "full-access",
      { semanticAnalysis: structured({
        goalType: "general",
        requiredEffects: [],
        candidateAgentIds: ["general"],
        acceptanceRequirements: [],
      }) },
    )
    expect(informational).toMatchObject({
      goalType: "general",
      requiredEffects: [],
      requiresEvidence: false,
    })

    const unadmittedPlanningRecommendation = compileObjective(
      "模型认为内容复杂，但运行时没有开启规划阶段",
      "full-access",
      { semanticAnalysis: structured({
        goalType: "research",
        requiredEffects: ["network"],
        candidateAgentIds: ["researcher"],
        requiresPlanning: true,
        acceptanceRequirements: [],
      }) },
    )
    expect(unadmittedPlanningRecommendation.requiredEffects).toEqual(["network"])

    const operational = compileObjective(
      "没有任何传统触发词的表达",
      "full-access",
      { semanticAnalysis: buildIntent() },
    )
    expect(operational.requiredEffects).toEqual(["workspace-write", "process"])
    expect(operational.acceptancePolicy?.requirements.map((item) => item.id)).toEqual([
      "mutation",
      "build",
    ])
  })

  test("an ordinary AgentLoop is not gated by an implicit acceptance contract", async () => {
    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)
    const loop = new AgentLoop({
      agentRegistry,
      toolRegistry,
      modelRouter: semanticRouter(() => ({})),
    }, 1)
    const run = loop.run({
      sessionId: `missing-policy-${crypto.randomUUID()}`,
      runType: "root",
      userMessage: "自然语言不能在这里被重新解释",
      agentId: "main-agent",
      workingDir: process.cwd(),
      scope: "full-access",
    })
    const events = []
    for await (const event of run) events.push(event)
    expect(events.some((event) => event.type === "error")).toBe(false)
  })

  test("required effects, not words or preferred role, drive capability selection", () => {
    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)
    const semanticAnalysis: SemanticTaskAnalysis = {
      ...buildIntent(["requirements-analyst"]),
      complexity: "simple",
      source: "model",
    }
    const selected = selectRuntimeAgent({
      message: "zhe jian shi qing nong hao",
      scope: "full-access",
      autoPlanning: false,
      planContinuation: false,
      requestedAgentId: "requirements-analyst",
      workingDir: process.cwd(),
      orchestrator: new AgentOrchestrator(),
      agentRegistry,
      toolRegistry,
      semanticAnalysis,
    })
    expect(selected.agent.id).toBe("main-agent")
    expect(selected.requiredEffects).toEqual(["workspace-write", "process"])
    expect(selected.executionAgent.id).not.toBe("requirements-analyst")
    expect(selected.executionAgent.tools).toEqual(expect.arrayContaining(["write", "compile"]))
    expect(selected.internallyReassigned).toBe(true)
  })

  test("cross-domain effects are covered collectively under the main Agent", () => {
    const agents = new AgentRegistry()
    agents.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)
    const semanticAnalysis: SemanticTaskAnalysis = {
      goalType: "hardware",
      complexity: "complex",
      requiredEffects: [
        "workspace-read",
        "workspace-write",
        "hardware",
        "network",
        "user-interaction",
      ],
      candidateAgentIds: ["hardware-engineer", "researcher", "doc-writer"],
      requiresPlanning: true,
      acceptanceRequirements: [
        {
          id: "mutation",
          label: "设计产物已生成",
          verifier: "mutation",
          anyOf: ["workspace-mutation"],
          targetPatterns: ["hardware/**/*"],
        },
        {
          id: "inspection",
          label: "设计产物已独立检查",
          verifier: "workspace-inspection",
          anyOf: ["workspace-inspection"],
          targetPatterns: ["hardware/**/*"],
        },
        {
          id: "hardware",
          label: "硬件操作已观测",
          verifier: "hardware",
          anyOf: ["hardware-observation"],
          targetPatterns: [],
        },
        {
          id: "research",
          label: "外部资料已核验",
          verifier: "research",
          anyOf: ["external-research"],
          targetPatterns: [],
        },
      ],
      source: "model",
    }

    const selected = selectRuntimeAgent({
      message: "跨域目标",
      scope: "full-access",
      autoPlanning: true,
      planContinuation: false,
      workingDir: process.cwd(),
      orchestrator: new AgentOrchestrator(),
      agentRegistry: agents,
      toolRegistry,
      semanticAnalysis,
    })

    expect(selected.agent.id).toBe("main-agent")
    expect(selected.executionAgent.mode).not.toBe("primary")
    expect(selected.requiredEffects).toEqual(expect.arrayContaining([
      "workspace-read",
      "workspace-write",
      "hardware",
      "network",
      "user-interaction",
      "delegation",
    ]))
  })

  test("missing specialist coverage returns control to the main Agent instead of rejecting admission", () => {
    const agents = new AgentRegistry()
    agents.registerAll(HIDDEN_AGENTS)
    const tools = new ToolRegistry()
    tools.registerAll(EMBEDDED_TOOLS.filter((tool) => tool.name === "read"))
    const semanticAnalysis: SemanticTaskAnalysis = {
      goalType: "hardware",
      complexity: "simple",
      requiredEffects: ["workspace-read", "hardware"],
      candidateAgentIds: ["hardware-engineer"],
      requiresPlanning: false,
      acceptanceRequirements: [],
      source: "model",
    }

    const selected = selectRuntimeAgent({
      message: "检查当前硬件状态并在能力不足时调整方案",
      scope: "full-access",
      autoPlanning: false,
      planContinuation: false,
      workingDir: process.cwd(),
      orchestrator: new AgentOrchestrator(),
      agentRegistry: agents,
      toolRegistry: tools,
      semanticAnalysis,
    })

    expect(selected.agent.id).toBe("main-agent")
    expect(selected.executionAgent.mode).not.toBe("primary")
    expect(selected.requiredEffects).toEqual(expect.arrayContaining(["hardware"]))
  })

  test("runtime-owned plan acceptance cannot be downgraded by an ID collision", () => {
    const collision = compileObjective("任意原文", "full-access", {
      autoPlanning: true,
      semanticAnalysis: structured({
        goalType: "implementation",
        requiredEffects: [],
        candidateAgentIds: ["general"],
        requiresPlanning: true,
        acceptanceRequirements: [{
          id: "plan",
          label: "试图用源码读取替代 plan",
          verifier: "source-inspection",
          anyOf: ["source-inspection"],
          targetPatterns: ["readme.md"],
        }],
      }),
    })
    expect(collision.requiredEffects).toEqual(["delegation"])
    expect(collision.acceptancePolicy).toBeUndefined()
  })

  test("schematic, network research, and artifact delivery execute without a forced plan protocol", async () => {
    let analysisCalls = 0
    const router = semanticRouter(() => {
      analysisCalls++
      return {
        goalType: "hardware",
        complexity: "complex",
        requiredEffects: ["workspace-read", "workspace-write", "network"],
        candidateAgentIds: ["hardware-engineer", "researcher", "doc-writer"],
        requiresPlanning: true,
      }
    })
    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)

    const result = await resolveRootAgentRouting({
      message: "请指导设计一个12V太阳能板逆变220V家用电的方案，检索安全规范并生成原理图设计文档",
      scope: "auto-edit",
      sessionId: "semantic-cross-domain-screenshot",
      requestId: "request-cross-domain-screenshot",
      rootRunId: "task-cross-domain-screenshot",
      workingDir: process.cwd(),
      modelRouter: router,
      agentRegistry,
      toolRegistry,
      orchestrator: new AgentOrchestrator(),
      systemSettings: normalizeSystemSettings({ toolPolicies: { terminal: "allow" } }),
      turnKind: "new-objective",
      mayAutoPlan: true,
      planContinuation: false,
    })

    expect(analysisCalls).toBe(1)
    expect(result.autoPlanning).toBe(false)
    expect(result.executionFlow.phase).toBe("execution")
    expect(result.selectedAgent.agent.id).toBe("main-agent")
    expect(result.selectedAgent.requiredEffects).toEqual([
      "workspace-read",
      "workspace-write",
      "network",
    ])
    expect(result.selectedAgent.objective.acceptancePolicy?.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime-workspace-inspection",
          verifier: "workspace-inspection",
          anyOf: ["workspace-inspection"],
        }),
        expect.objectContaining({
          id: "runtime-network-research",
          verifier: "research",
          anyOf: ["external-research"],
        }),
        expect.objectContaining({
          id: "runtime-workspace-mutation",
          verifier: "mutation",
          anyOf: ["workspace-mutation"],
        }),
      ]),
    )
  })

  test("domain questions cannot acquire implementation, build, hardware, or delegation effects", async () => {
    const router = semanticRouter(() => ({
      goalType: "hardware",
      complexity: "complex",
      requiredEffects: [
        "workspace-read",
        "workspace-write",
        "process",
        "network",
        "hardware",
        "user-interaction",
        "delegation",
      ],
      candidateAgentIds: ["hardware-engineer", "researcher"],
      requiresPlanning: true,
    }))
    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)

    const result = await resolveRootAgentRouting({
      message: "支持STM32的芯片开发吗？",
      scope: "full-access",
      sessionId: "domain-query-boundary",
      requestId: "domain-query-request",
      rootRunId: "domain-query-run",
      workingDir: process.cwd(),
      modelRouter: router,
      agentRegistry,
      toolRegistry,
      orchestrator: new AgentOrchestrator(),
      systemSettings: normalizeSystemSettings({ toolPolicies: { terminal: "allow" } }),
      turnKind: "domain-query",
      mayAutoPlan: true,
      planContinuation: false,
    })

    expect(result.autoPlanning).toBe(false)
    expect(result.executionFlow.phase).toBe("execution")
    expect(result.semanticAnalysis).toMatchObject({
      complexity: "simple",
      requiresPlanning: false,
      requiredEffects: [],
    })
    expect(result.selectedAgent.requiredEffects).toEqual([])
    expect(result.selectedAgent.objective.acceptancePolicy).toBeUndefined()
  })

  test("response-only routing preserves inspection only for an admitted resource", () => {
    const base: SemanticTaskAnalysis = {
      goalType: "documentation",
      complexity: "complex",
      requiredEffects: ["workspace-read", "network"],
      candidateAgentIds: ["explore"],
      requiresPlanning: true,
      acceptanceRequirements: [
        {
          id: "manual",
          label: "技术手册已经读取",
          verifier: "workspace-inspection",
          anyOf: ["workspace-inspection"],
          targetPatterns: ["manual.pdf"],
        },
        {
          id: "research",
          label: "外部资料已经检索",
          verifier: "research",
          anyOf: ["external-research"],
          targetPatterns: [],
        },
      ],
      source: "model",
    }

    const directAnswer = constrainSemanticAnalysisForTurn(base, "new-objective")
    expect(directAnswer).toMatchObject({
      complexity: "complex",
      requiredEffects: ["workspace-read", "network"],
      requiresPlanning: true,
    })

    const attachedManual = constrainSemanticAnalysisForTurn(
      base,
      "domain-query",
      [{ name: "manual.pdf", mime: "application/pdf", kind: "text" }],
    )
    expect(attachedManual).toMatchObject({
      complexity: "simple",
      requiredEffects: ["workspace-read"],
      requiresPlanning: false,
    })
    expect(attachedManual.acceptanceRequirements.map((requirement) => requirement.id))
      .toEqual(["manual"])
  })

  test("conversation authority preserves operational plans and constrains response-only plans", () => {
    const inventedArtifacts: SemanticTaskAnalysis = {
      goalType: "plan",
      complexity: "complex",
      requiredEffects: ["workspace-read", "workspace-write"],
      candidateAgentIds: ["architect", "doc-writer"],
      requiresPlanning: true,
      acceptanceRequirements: [{
        id: "invented-file",
        label: "模型自行发明的方案文件",
        verifier: "mutation",
        anyOf: ["workspace-mutation"],
        targetPatterns: ["invented/design.md"],
      }],
      source: "model",
    }

    const chatPlan = constrainSemanticAnalysisForTurn(
      inventedArtifacts,
      "domain-query",
      [],
      "auto-edit",
    )
    expect(chatPlan).toMatchObject({
      complexity: "simple",
      requiredEffects: [],
      requiresPlanning: false,
      acceptanceRequirements: [],
    })

    const operationalPlan = constrainSemanticAnalysisForTurn(
      inventedArtifacts,
      "new-objective",
      [],
      "auto-edit",
    )
    expect(operationalPlan.requiredEffects).toEqual(["workspace-read", "workspace-write"])
    expect(operationalPlan.requiresPlanning).toBe(true)
  })

  test("semantic effects are advisory and cannot shrink the main Agent tool surface", async () => {
    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)
    const result = await resolveRootAgentRouting({
      message: "设计方案并保存到工作区文档",
      scope: "auto-edit",
      sessionId: "advisory-semantic-effects",
      requestId: "advisory-semantic-effects-request",
      rootRunId: "advisory-semantic-effects-run",
      workingDir: process.cwd(),
      modelRouter: null,
      agentRegistry,
      toolRegistry,
      orchestrator: new AgentOrchestrator(),
      systemSettings: normalizeSystemSettings({ toolPolicies: { terminal: "allow" } }),
      turnKind: "new-objective",
      mayAutoPlan: true,
      planContinuation: false,
      semanticTaskAnalyzer: async () => ({
        goalType: "plan",
        complexity: "simple",
        requiredEffects: [],
        candidateAgentIds: ["architect", "doc-writer"],
        requiresPlanning: false,
        acceptanceRequirements: [],
        source: "model",
      }),
    })

    expect(result.selectedAgent.requiredEffects).toEqual([])
    expect(result.selectedAgent.executionAgent.id).toBe("architect")
    expect(result.selectedAgent.agent.id).toBe("main-agent")
    expect(result.selectedAgent.agent.tools).toEqual(expect.arrayContaining([
      "read", "write", "bash", "task",
    ]))
  })

  test("semantic helper failure falls back to the permission-gated general role", async () => {
    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)
    const result = await resolveRootAgentRouting({
      message: "继续完成当前工作",
      scope: "auto-edit",
      sessionId: "semantic-advisory-fallback",
      requestId: "semantic-advisory-fallback-request",
      rootRunId: "semantic-advisory-fallback-run",
      workingDir: process.cwd(),
      modelRouter: null,
      agentRegistry,
      toolRegistry,
      orchestrator: new AgentOrchestrator(),
      systemSettings: normalizeSystemSettings({ toolPolicies: { terminal: "allow" } }),
      turnKind: "new-objective",
      mayAutoPlan: true,
      planContinuation: false,
      semanticTaskAnalyzer: async () => {
        throw new SemanticTaskAnalysisUnavailableError("辅助模型不可用")
      },
    })

    expect(result.semanticAnalysis).toMatchObject({
      source: "runtime-fallback",
      requiredEffects: [],
      candidateAgentIds: ["general"],
    })
    expect(result.semanticAnalysis.fallbackReason).toContain("辅助模型不可用")
    expect(result.selectedAgent.executionAgent.id).toBe("general")
    expect(result.selectedAgent.agent.id).toBe("main-agent")
  })

  test("one request-bound analysis drives planning, selection and compilation", async () => {
    let analysisCalls = 0
    const router = semanticRouter(() => {
      analysisCalls++
      return {
        goalType: "implementation",
        complexity: "complex",
        requiredEffects: ["workspace-write", "process"],
        candidateAgentIds: ["firmware-engineer", "test-engineer"],
        requiresPlanning: true,
      }
    })
    const agentRegistry = new AgentRegistry()
    agentRegistry.registerAll(HIDDEN_AGENTS)
    const toolRegistry = new ToolRegistry()
    toolRegistry.registerAll(EMBEDDED_TOOLS)
    const result = await resolveRootAgentRouting({
      message: "让现有工程成为可交付结果，并证明没有破坏原有行为",
      scope: "full-access",
      sessionId: "semantic-root-routing",
      requestId: "request-root-routing",
      rootRunId: "task-root-routing",
      workingDir: process.cwd(),
      modelRouter: router,
      agentRegistry,
      toolRegistry,
      orchestrator: new AgentOrchestrator(),
      systemSettings: normalizeSystemSettings({ toolPolicies: { terminal: "allow" } }),
      turnKind: "new-objective",
      mayAutoPlan: true,
      planContinuation: false,
    })

    expect(analysisCalls).toBe(1)
    expect(result.autoPlanning).toBe(false)
    expect(result.executionFlow.phase).toBe("execution")
    expect(result.selectedAgent.agent.id).toBe("main-agent")
    expect(result.selectedAgent.executionAgent.id).toBe("firmware-engineer")
    expect(result.selectedAgent.requiredEffects).toEqual([
      "workspace-write",
      "process",
    ])
    expect(result.selectedAgent.objective.acceptancePolicy?.requirements
      .map((requirement) => requirement.id)).toEqual([
        "runtime-workspace-mutation",
        "runtime-workspace-verification",
        "runtime-process-verification",
      ])
  })
})

function structured(
  input: Omit<StructuredObjectiveIntent, "requiresPlanning"> & { requiresPlanning?: boolean },
): StructuredObjectiveIntent {
  return { ...input, requiresPlanning: input.requiresPlanning ?? false }
}

function buildIntent(candidateAgentIds = ["firmware-engineer"]): StructuredObjectiveIntent {
  return structured({
    goalType: "implementation",
    requiredEffects: ["workspace-write", "process"],
    candidateAgentIds,
    acceptanceRequirements: [
      {
        id: "mutation",
        label: "变更已登记",
        verifier: "mutation",
        anyOf: ["workspace-mutation"],
        targetPatterns: ["src/main.c"],
      },
      {
        id: "build",
        label: "构建成功",
        verifier: "build",
        anyOf: ["build-success"],
        targetPatterns: [],
      },
    ],
  })
}

function semanticRouter(
  resolve: (input: string) => Record<string, unknown>,
): ModelRouter {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as {
        messages?: Array<{ role?: string; content?: string }>
      }
      const payload = body.messages?.findLast((message) => message.role === "user")?.content ?? "{}"
      let input = payload
      try {
        input = (JSON.parse(payload) as { userRequest?: string }).userRequest ?? ""
      } catch {
        // This shared model fixture also supports an ordinary AgentLoop turn,
        // whose user content is intentionally not the semantic JSON protocol.
      }
      const chunk = {
        choices: [{
          delta: { content: JSON.stringify(resolve(input)) },
          finish_reason: "stop",
        }],
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  servers.push(server)
  return new ModelRouter([{
    id: `semantic-${server.port}`,
    name: "Semantic test model",
    provider: "openai-compatible",
    modelId: `semantic-${server.port}`,
    apiKey: "test",
    baseUrl: `http://127.0.0.1:${server.port}`,
    capabilities: ["reasoning", "coding", "chat"],
    priority: 1,
    costFactor: 1,
    enabled: true,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
  }])
}
