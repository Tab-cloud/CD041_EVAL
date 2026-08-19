import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { AgentDefinition } from "../src/agent/types.ts"
import type { ToolDefinition, ToolEffect } from "../src/tool/types.ts"
import { authorizeTool, evaluateToolAuthorization, filterToolsForScope, type RuntimeToolPolicy } from "../src/runtime/tool-policy.ts"
import { isPrivateAddress } from "../src/tool/general/webfetch.ts"
import { ToolApprovalManager } from "../src/runtime/tool-approval.ts"
import { editTool, writeTool } from "../src/tool/fs/index.ts"
import { HIDDEN_AGENTS } from "../src/agent/definitions/all.ts"
import { bashTool } from "../src/tool/general/bash.ts"
import { todowriteTool } from "../src/tool/general/todowrite.ts"
import { compileTool } from "../src/tool/hardware/compile.ts"
import { RuntimeAccessManager } from "../src/runtime/runtime-access.ts"
import { UserQuestionManager } from "../src/runtime/user-question.ts"
import { mainAgent } from "../src/agent/definitions/main-agent.ts"
import { normalizeInboundToolCall } from "../src/runtime/tool-call-normalization.ts"
import { taskTool } from "../src/tool/general/task.ts"
import { webfetchTool } from "../src/tool/general/webfetch.ts"
import { communityTools } from "../src/tool/community/index.ts"

const agent: AgentDefinition = {
  id: "test",
  name: "test",
  description: "",
  mode: "hidden",
  requiredCapabilities: ["chat"],
  tools: ["read", "write", "flash"],
  permissions: [
    { permission: "read", pattern: "*", effect: "allow" },
    { permission: "write", pattern: "*", effect: "allow" },
    { permission: "flash", pattern: "*", effect: "deny" },
  ],
  systemPrompt: "",
  maxSteps: 1,
}

const tool = (name: string, permission: string, effects: ToolEffect[] = []): ToolDefinition => ({
  name,
  permission,
  description: "",
  parameters: { type: "object" },
  contract: { effects, idempotency: effects.length === 0 ? "read-only" : "unknown", cancellation: "unsupported", progress: { role: "dynamic" } },
  execute: async () => ({ success: true }),
})

describe("tool policy", () => {
  const tools = [tool("read", "read", ["workspace-read"]), tool("write", "write", ["workspace-write"]), tool("flash", "flash", ["hardware"])]
  const policy: RuntimeToolPolicy = {
    toolPolicies: { fileWrite: "allow", terminal: "ask", network: "allow", hardware: "ask" },
    writePathAllowlist: [],
    commandAllowlist: [],
  }

  test("plan mode exposes only non-mutating tools", () => {
    expect(filterToolsForScope(agent, tools, "plan-mode").map((item) => item.name)).toEqual(["read"])
  })

  test("community tools require the independent parent and child policies", () => {
    const communityPolicy: RuntimeToolPolicy = {
      ...policy,
      communityAutomation: {
        enabled: true,
        forumExplore: "allow",
        forumReply: "ask",
        forumCreateTopic: "deny",
        blogCreateDraft: "ask",
        blogPublish: "deny",
      },
    }
    const read = communityTools.find((item) => item.name === "community_forum_read")!
    const reply = communityTools.find((item) => item.name === "community_forum_reply")!
    const topic = communityTools.find((item) => item.name === "community_forum_create_topic")!
    expect(filterToolsForScope(mainAgent, [read, reply, topic], "auto-edit", communityPolicy).map((item) => item.name))
      .toEqual(["community_forum_read", "community_forum_reply"])
    expect(filterToolsForScope(mainAgent, [read, reply], "plan-mode", communityPolicy).map((item) => item.name))
      .toEqual(["community_forum_read"])
    expect(evaluateToolAuthorization(mainAgent, reply, new Set([reply.name]), "auto-edit", { topicId: "topic_1", body: "test" }, communityPolicy).action)
      .toBe("ask")
    expect(filterToolsForScope(mainAgent, [read, reply], "auto-edit", {
      ...communityPolicy, communityAutomation: { ...communityPolicy.communityAutomation!, enabled: false },
    })).toEqual([])
  })

  test("agent deny rules are enforced even in full access", () => {
    expect(authorizeTool(agent, tools[2], new Set(["flash"]), "full-access")).toContain("明确禁止")
  })

  test("confirm changes exposes workspace writes and asks before execution", () => {
    expect(filterToolsForScope(agent, tools, "confirm-changes").map((item) => item.name)).toEqual(["read", "write", "flash"])
    expect(evaluateToolAuthorization(agent, tools[1], new Set(["write"]), "confirm-changes", { path: "src/main.c" }).action).toBe("ask")
  })

  test("permission patterns limit write targets", () => {
    const scoped = { ...agent, permissions: [{ permission: "write", pattern: "src/**", effect: "allow" as const }] }
    expect(evaluateToolAuthorization(scoped, tools[1], new Set(["write"]), "auto-edit", { path: "src/main.c" }).action).toBe("allow")
    expect(evaluateToolAuthorization(scoped, tools[1], new Set(["write"]), "auto-edit", { path: "outside.txt" }).action).toBe("deny")
  })

  test("file tools use matching write and edit permissions", () => {
    expect(writeTool.permission).toBe("write")
    expect(editTool.permission).toBe("edit")
  })

  test("system deny hides tools and ask requires approval in full access", () => {
    const denied = { ...policy, toolPolicies: { ...policy.toolPolicies, fileWrite: "deny" as const } }
    expect(filterToolsForScope(agent, tools, "full-access", denied).map((item) => item.name)).toEqual(["read", "flash"])

    const hardwareAgent = { ...agent, permissions: [], tools: ["flash"] }
    // A system-level "ask" policy cannot mint authority absent from the Agent.
    expect(evaluateToolAuthorization(hardwareAgent, tools[2], new Set(["flash"]), "full-access", {}, policy).action).toBe("deny")
  })

  test("system write path allowlist cannot be bypassed by full access", () => {
    const restricted = { ...policy, writePathAllowlist: ["src/**"], workingDir: process.cwd() }
    expect(evaluateToolAuthorization(agent, tools[1], new Set(["write"]), "full-access", { path: "src/main.c" }, restricted).action).toBe("allow")
    expect(evaluateToolAuthorization(agent, tools[1], new Set(["write"]), "full-access", { path: "secrets.txt" }, restricted).action).toBe("deny")
    expect(evaluateToolAuthorization(agent, tools[1], new Set(["write"]), "full-access", { path: "src/../secrets.txt" }, restricted).action).toBe("deny")
    expect(evaluateToolAuthorization(agent, tools[1], new Set(["write"]), "full-access", { path: "src/sub/../../secrets.txt" }, restricted).action).toBe("deny")
    expect(evaluateToolAuthorization(agent, tools[1], new Set(["write"]), "full-access", { path: resolve(process.cwd(), "secrets.txt") }, restricted).action).toBe("deny")
  })

  test("command allowlist authorizes one invocation and rejects shell composition", () => {
    const restricted: RuntimeToolPolicy = {
      toolPolicies: { fileWrite: "allow", terminal: "allow", network: "allow", hardware: "allow" },
      writePathAllowlist: [],
      commandAllowlist: ["git diff*"],
    }
    const decide = (command: string) => evaluateToolAuthorization(
      mainAgent, bashTool, new Set(["bash"]), "full-access", { command }, restricted,
    ).action

    expect(decide("git diff --stat")).toBe("allow")
    expect(decide("git diff -- 'file;name.txt'")).toBe("allow")
    expect(decide("git diff; Set-Content owned.txt x")).toBe("deny")
    expect(decide("git diff | Set-Content owned.txt")).toBe("deny")
    expect(decide("git diff > owned.txt")).toBe("deny")
    expect(decide("git diff $(Invoke-WebRequest example.com)")).toBe("deny")
    expect(decide("git diff `n; Invoke-WebRequest example.com")).toBe("deny")
  })

  test("bash is hidden only in plan mode and policy-gated in execution modes", () => {
    const commandAgent = {
      ...agent,
      tools: ["read", "bash", "compile"],
      permissions: [
        { permission: "bash", pattern: "*", effect: "allow" as const },
        { permission: "compile", pattern: "*", effect: "allow" as const },
      ],
    }
    const unrestrictedEffects: ToolEffect[] = ["workspace-read", "workspace-write", "process", "network", "hardware"]
    const commandTools = [tool("read", "read", ["workspace-read"]), tool("bash", "bash", unrestrictedEffects), tool("compile", "compile", unrestrictedEffects)]
    expect(filterToolsForScope(commandAgent, commandTools, "plan-mode", policy).map((item) => item.name)).toEqual(["read"])
    expect(filterToolsForScope(commandAgent, commandTools, "auto-edit", policy).map((item) => item.name)).toEqual(["read", "bash", "compile"])
    expect(filterToolsForScope(commandAgent, commandTools, "confirm-changes", policy).map((item) => item.name)).toEqual(["read", "bash", "compile"])
    expect(evaluateToolAuthorization(commandAgent, commandTools[1], new Set(["bash"]), "auto-edit", { command: "make" }, policy).action).toBe("ask")

    const deniedNetwork = { ...policy, toolPolicies: { fileWrite: "allow" as const, terminal: "allow" as const, network: "deny" as const, hardware: "allow" as const } }
    expect(evaluateToolAuthorization(commandAgent, commandTools[1], new Set(["bash"]), "full-access", { command: "make" }, deniedNetwork).action).toBe("deny")
    const allowed = { ...policy, toolPolicies: { fileWrite: "allow" as const, terminal: "allow" as const, network: "allow" as const, hardware: "allow" as const } }
    expect(evaluateToolAuthorization(commandAgent, commandTools[1], new Set(["bash"]), "full-access", { command: "make" }, allowed).action).toBe("allow")
  })

  test("generic tools stay visible while each concrete effect follows its own policy", () => {
    const separated = {
      ...policy,
      toolPolicies: {
        fileWrite: "allow" as const,
        terminal: "allow" as const,
        network: "deny" as const,
        hardware: "deny" as const,
      },
    }
    const visible = filterToolsForScope(mainAgent, [bashTool], "auto-edit", separated)
    expect(visible.map((item) => item.name)).toEqual(["bash"])
    expect(evaluateToolAuthorization(
      mainAgent, bashTool, new Set(["bash"]), "auto-edit", { command: "where git" }, separated,
    ).action).toBe("allow")
    expect(evaluateToolAuthorization(
      mainAgent, bashTool, new Set(["bash"]), "auto-edit", { command: "curl https://example.com" }, separated,
    ).action).toBe("deny")
    expect(evaluateToolAuthorization(
      mainAgent, bashTool, new Set(["bash"]), "auto-edit", { command: "openocd -f board.cfg" }, separated,
    ).action).toBe("deny")
    expect(filterToolsForScope(mainAgent, [taskTool, webfetchTool], "auto-edit", separated)
      .map((item) => item.name)).toEqual(["task"])
  })

  test("the four conversation scopes preserve distinct responsibilities", () => {
    const scopedTools = [tools[0]!, writeTool, bashTool, tools[2]!]
    expect(filterToolsForScope(mainAgent, scopedTools, "plan-mode", policy).map((item) => item.name))
      .toEqual(["read"])
    for (const scope of ["confirm-changes", "auto-edit", "full-access"] as const) {
      expect(filterToolsForScope(mainAgent, scopedTools, scope, policy).map((item) => item.name))
        .toEqual(["read", "write", "bash", "flash"])
    }

    expect(evaluateToolAuthorization(
      mainAgent, writeTool, new Set(["write"]), "confirm-changes", { path: "src/main.c" }, policy,
    ).action).toBe("ask")
    expect(evaluateToolAuthorization(
      mainAgent, writeTool, new Set(["write"]), "auto-edit", { path: "src/main.c" }, policy,
    ).action).toBe("allow")
    expect(evaluateToolAuthorization(
      mainAgent, bashTool, new Set(["bash"]), "auto-edit", { command: "where git" }, policy,
    ).action).toBe("ask")
    expect(evaluateToolAuthorization(
      mainAgent, tools[2], new Set(["flash"]), "auto-edit", {}, policy,
    ).action).toBe("ask")

    const access = new RuntimeAccessManager()
    access.begin("full-scope", "full-access")
    const fullAccessTerminal = evaluateToolAuthorization(
      mainAgent, bashTool, new Set(["bash"]), "full-access", { command: "where git" }, policy,
    )
    expect(access.resolveAuthorization("full-scope", fullAccessTerminal).action).toBe("allow")
  })

  test("provider shell dialect resolves to the main Agent bash grant without widening authority", () => {
    const allowed = {
      ...policy,
      toolPolicies: {
        fileWrite: "allow" as const,
        terminal: "allow" as const,
        network: "allow" as const,
        hardware: "allow" as const,
      },
    }
    const normalized = normalizeInboundToolCall("shell", { exec: "make -C Code/V1.0" })
    const visible = filterToolsForScope(mainAgent, [compileTool, bashTool], "full-access", allowed)

    expect(normalized).toEqual({
      name: "bash",
      input: { command: "make -C Code/V1.0" },
    })
    expect(visible.map((item) => item.name)).toEqual(["compile", "bash"])
    expect(evaluateToolAuthorization(
      mainAgent,
      bashTool,
      new Set(visible.map((item) => item.name)),
      "full-access",
      normalized.input,
      allowed,
    ).action).toBe("allow")
  })

  test("the real build agent is read-only while planning and can repair then build during execution", () => {
    const buildAgent = HIDDEN_AGENTS.find((item) => item.id === "build-agent")!
    const buildTools = [bashTool, compileTool, writeTool, editTool, todowriteTool]
    expect(filterToolsForScope(buildAgent, buildTools, "plan-mode", policy).map((item) => item.name)).toEqual(["todowrite"])

    const visible = filterToolsForScope(buildAgent, buildTools, "auto-edit", policy)
    expect(visible.map((item) => item.name)).toEqual(["bash", "compile", "write", "edit", "todowrite"])
    expect(evaluateToolAuthorization(buildAgent, bashTool, new Set(["bash"]), "auto-edit", { command: "where arm-none-eabi-gcc" }, policy).action).toBe("ask")
    expect(evaluateToolAuthorization(buildAgent, writeTool, new Set(visible.map((item) => item.name)), "auto-edit", { path: "hello/Makefile" }, policy).action).toBe("allow")
  })

  test("the delegated build subagent remains unable to edit source files", async () => {
    const { buildAgent } = await import("../src/agent/definitions/subagents.ts")
    const visible = filterToolsForScope(buildAgent, [compileTool, bashTool, writeTool, editTool], "auto-edit", policy)
    expect(visible.map((item) => item.name)).toEqual(["compile", "bash"])
  })
})

describe("tool approvals", () => {
  const create = (manager: ToolApprovalManager, signal?: AbortSignal) => manager.create({
    sessionId: "session", toolCallId: "call", toolName: "write",
    toolInput: { path: "src/main.c", apiKey: "secret" }, reason: "test", signal,
  })

  test("approval response resumes a pending operation and redacts secrets", async () => {
    const manager = new ToolApprovalManager()
    const pending = create(manager)
    expect(pending.request.input.apiKey).toBe("[已隐藏]")
    expect(manager.respond(pending.request.id, true)?.id).toBe(pending.request.id)
    expect(await pending.outcome).toBe("approved")
    expect(manager.list()).toEqual([])
    expect(manager.respond(pending.request.id, true)).toBeNull()
  })

  test("approval redaction covers nested authorization values", () => {
    const manager = new ToolApprovalManager(10_000)
    const pending = manager.create({
      sessionId: "nested", toolCallId: "nested", toolName: "mcp",
      toolInput: { headers: { Authorization: "Bearer private", nested: { accessToken: "private" } } }, reason: "确认",
    })
    expect(JSON.stringify(pending.request.input)).not.toContain("private")
    manager.respond(pending.request.id, false)
  })

  test("pending approvals can be discovered by session for background runs", () => {
    const manager = new ToolApprovalManager(10_000)
    const first = manager.create({ sessionId: "one", toolCallId: "a", toolName: "compile", toolInput: {}, reason: "确认" })
    const second = manager.create({ sessionId: "two", toolCallId: "b", toolName: "flash", toolInput: {}, reason: "确认" })
    expect(manager.list("one").map((item) => item.id)).toEqual([first.request.id])
    manager.respond(first.request.id, false)
    manager.respond(second.request.id, false)
  })

  test("allow all approves every pending operation in the same session", async () => {
    const manager = new ToolApprovalManager(10_000)
    const first = manager.create({ sessionId: "one", toolCallId: "a", toolName: "bash", toolInput: {}, reason: "确认" })
    const second = manager.create({ sessionId: "one", toolCallId: "b", toolName: "write", toolInput: {}, reason: "确认" })
    const other = manager.create({ sessionId: "two", toolCallId: "c", toolName: "flash", toolInput: {}, reason: "确认" })

    expect(manager.respond(first.request.id, "allow-all")?.id).toBe(first.request.id)
    expect(await first.outcome).toBe("approved")
    expect(await second.outcome).toBe("approved")
    expect(manager.list("one")).toEqual([])
    expect(manager.list("two").map((item) => item.id)).toEqual([other.request.id])
    manager.respond(other.request.id, "deny")
  })

  test("abort and timeout settle pending approvals", async () => {
    const controller = new AbortController()
    const cancelled = create(new ToolApprovalManager(), controller.signal)
    controller.abort()
    expect(await cancelled.outcome).toBe("cancelled")

    const expired = create(new ToolApprovalManager(5))
    expect(await expired.outcome).toBe("expired")
  })
})

describe("user questions", () => {
  test("a choice keeps the original operation pending and resumes it with the answer", async () => {
    const manager = new UserQuestionManager()
    const pending = manager.create({
      sessionId: "session",
      runId: "run",
      toolCallId: "question-call",
      question: "请选择主控型号",
      options: ["LJ5230B", "LJ5230"],
    })
    let settled = false
    void pending.outcome.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(manager.list("session")).toEqual([pending.request])
    expect(manager.respond(pending.request.id, "LJ5230B")?.id).toBe(pending.request.id)
    expect(await pending.outcome).toEqual({ status: "answered", answer: "LJ5230B" })
    expect(manager.list()).toEqual([])
  })

  test("aborting the run dismisses its pending question", async () => {
    const controller = new AbortController()
    const manager = new UserQuestionManager()
    const pending = manager.create({
      sessionId: "session", toolCallId: "question-call",
      question: "继续吗？", signal: controller.signal,
    })
    controller.abort()
    expect(await pending.outcome).toEqual({ status: "cancelled" })
    expect(manager.list()).toEqual([])
  })

  test("a user can cancel a pending question without answering or resuming the operation", async () => {
    const manager = new UserQuestionManager()
    const pending = manager.create({
      sessionId: "session", toolCallId: "compile-target",
      question: "请选择主控型号", options: ["LJ5230B"],
    })
    expect(manager.cancel(pending.request.id)?.id).toBe(pending.request.id)
    expect(await pending.outcome).toEqual({ status: "cancelled" })
    expect(manager.list()).toEqual([])
    expect(manager.cancel(pending.request.id)).toBeNull()
  })

  test("a closed target question rejects arbitrary text and remains pending", async () => {
    const manager = new UserQuestionManager()
    const pending = manager.create({
      sessionId: "session",
      toolCallId: "compile-family",
      question: "请选择底层芯片族",
      options: ["N32WB03X"],
      allowCustom: false,
    })
    let settled = false
    void pending.outcome.then(() => { settled = true })

    expect(manager.validateAnswer(pending.request.id, "LJ5230B")).toEqual({
      valid: false,
      reason: "invalid-choice",
    })
    expect(manager.respond(pending.request.id, "LJ5230B")).toBeNull()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(manager.list()).toEqual([pending.request])

    expect(manager.validateAnswer(pending.request.id, "N32WB03X").valid).toBe(true)
    expect(manager.respond(pending.request.id, "N32WB03X")?.id).toBe(pending.request.id)
    expect(await pending.outcome).toEqual({ status: "answered", answer: "N32WB03X" })
  })

  test("an open question still accepts a custom answer", async () => {
    const manager = new UserQuestionManager()
    const pending = manager.create({
      sessionId: "session",
      toolCallId: "generic-question",
      question: "请补充说明",
      options: ["选项一"],
    })
    expect(pending.request.allowCustom).toBe(true)
    expect(manager.respond(pending.request.id, "自定义内容")?.id).toBe(pending.request.id)
    expect(await pending.outcome).toEqual({ status: "answered", answer: "自定义内容" })
  })
})

describe("runtime access", () => {
  test("scope changes and allow-all are visible during an active run", () => {
    const manager = new RuntimeAccessManager()
    manager.begin("session", "auto-edit")
    expect(manager.getScope("session", "plan-mode")).toBe("auto-edit")
    expect(manager.shouldApprove("session")).toBe(false)

    manager.allowAll("session")
    expect(manager.getScope("session", "auto-edit")).toBe("full-access")
    expect(manager.shouldApprove("session")).toBe(true)
    expect(manager.resolveAuthorization("session", { action: "ask", reason: "系统要求确认" })).toEqual({ action: "allow" })
    expect(manager.resolveAuthorization("session", { action: "deny", reason: "系统禁止" })).toEqual({ action: "deny", reason: "系统禁止" })

    manager.set("session", "confirm-changes")
    expect(manager.getScope("session", "auto-edit")).toBe("confirm-changes")
    expect(manager.shouldApprove("session")).toBe(false)
  })
})

test("SSRF address classifier rejects local and special networks", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
    expect(isPrivateAddress(address)).toBe(true)
  }
  expect(isPrivateAddress("8.8.8.8")).toBe(false)
})
