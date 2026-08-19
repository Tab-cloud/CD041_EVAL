import { describe, expect, test } from "bun:test"
import { appReducer, createInitialState, updateAssistantMessage, type AppState } from "../src/store"
import { restoreSession } from "../src/session-restore"

describe("new chat session binding", () => {
  test("binding a backend session preserves in-flight messages", () => {
    const messages = [
      { role: "user" as const, content: "hi", timestamp: 1 },
      { role: "assistant" as const, content: "", timestamp: 2 },
    ]
    const state = { activeSessionId: null, messages } as AppState

    const next = appReducer(state, { type: "BIND_ACTIVE_SESSION", sessionId: "session-1" })

    expect(next.activeSessionId).toBe("session-1")
    expect(next.liveBoundSessionId).toBe("session-1")
    expect(next.messages).toEqual(messages)

    const selected = appReducer({
      ...next,
      sessions: [{ id: "session-1", title: "one", updatedAt: 1 }],
      sessionRestoreNonce: 0,
      buildLogsBySession: {},
      agentLogsBySession: {},
    } as AppState, { type: "SET_ACTIVE_SESSION", sessionId: "session-1" })
    expect(selected.liveBoundSessionId).toBeNull()
    expect(selected.sessionRestoreNonce).toBe(1)
  })

  test("streaming output never overwrites the restored user message", () => {
    const messages = [{ role: "user" as const, content: "hi", timestamp: 1 }]

    const next = updateAssistantMessage(messages, "hello")

    expect(next.map((message) => [message.role, message.content])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ])
  })

  test("terminal task state pauses stale in-progress todos", () => {
    const state = {
      activeSessionId: null,
      todos: [
        { content: "实现驱动", status: "in_progress" as const, priority: "high" as const },
        { content: "等待硬件", status: "blocked" as const, priority: "low" as const },
      ],
    } as AppState
    const next = appReducer(state, { type: "PAUSE_RUNNING_TODOS" })
    expect(next.todos.map((todo) => todo.status)).toEqual(["paused", "blocked"])
  })

  test("pending questions are globally queued and removed after answering", () => {
    let state = {
      pendingQuestions: [],
    } as unknown as AppState
    state = appReducer(state, {
      type: "UPSERT_PENDING_QUESTION",
      question: { id: "q1", sessionId: "s1", question: "选择型号", options: ["A", "B"], createdAt: 1 },
    })
    state = appReducer(state, {
      type: "UPSERT_PENDING_QUESTION",
      question: { id: "q2", sessionId: "s2", question: "确认电压", options: [], createdAt: 2 },
    })
    expect(state.pendingQuestions.map((item) => item.id)).toEqual(["q1", "q2"])
    state = appReducer(state, { type: "REMOVE_PENDING_QUESTION", questionId: "q1" })
    expect(state.pendingQuestions.map((item) => item.id)).toEqual(["q2"])
  })

  test("switching conversations restores their model, thinking and edit settings", () => {
    const sessions = [
      {
        id: "session-a", title: "A", agentId: "main-agent", createdAt: 1, updatedAt: 1,
        composerPreferences: { modelId: "model-a", effort: "off" as const, scope: "confirm-changes" as const },
      },
      {
        id: "session-b", title: "B", agentId: "main-agent", createdAt: 2, updatedAt: 2,
        composerPreferences: { modelId: "model-b", effort: "on" as const, scope: "auto-edit" as const },
      },
    ]
    let state = {
      sessions,
      activeSessionId: "session-a",
      sessionRestoreNonce: 0,
      activeModelId: "model-a",
      buildLogsBySession: {},
      agentLogsBySession: {},
    } as unknown as AppState

    state = appReducer(state, { type: "SET_ACTIVE_SESSION", sessionId: "session-b" })
    expect(state.activeModelId).toBe("model-b")
    expect(state.sessionRestoreNonce).toBe(1)
    expect(state.sessions.find((session) => session.id === "session-b")?.composerPreferences)
      .toEqual({ modelId: "model-b", effort: "on", scope: "auto-edit" })

    state = appReducer(state, {
      type: "UPDATE_SESSION_PREFERENCES",
      sessionId: "session-b",
      preferences: { modelId: null, effort: "off", scope: "full-access" },
    })
    expect(state.activeModelId).toBeNull()
    expect(state.sessions.find((session) => session.id === "session-a")?.composerPreferences?.modelId)
      .toBe("model-a")
    expect(state.sessions.find((session) => session.id === "session-b")?.composerPreferences)
      .toEqual({ modelId: null, effort: "off", scope: "full-access" })
  })

  test("disabling a selected model immediately returns affected conversations to automatic routing", () => {
    const state = {
      modelConfigs: [],
      activeModelId: "@provider::disabled",
      sessions: [{
        id: "session-a", title: "A", agentId: "main-agent", createdAt: 1, updatedAt: 1,
        composerPreferences: {
          modelId: "@provider::disabled",
          effort: "on" as const,
          scope: "auto-edit" as const,
        },
      }],
    } as unknown as AppState
    const configs = [{
      id: "provider", name: "Provider", provider: "openai-compatible", modelId: "enabled",
      capabilities: ["chat" as const], priority: 50, costFactor: 1, enabled: true,
      contextWindow: 128_000, maxOutputTokens: 64_000,
      models: [{
        id: "enabled", name: "Enabled", modelId: "enabled", capabilities: ["chat" as const],
        priority: 50, costFactor: 1, enabled: true, contextWindow: 128_000, maxOutputTokens: 64_000,
      }, {
        id: "disabled", name: "Disabled", modelId: "disabled", capabilities: ["chat" as const],
        priority: 50, costFactor: 1, enabled: false, contextWindow: 128_000, maxOutputTokens: 64_000,
      }],
    }]

    const next = appReducer(state, { type: "SET_MODEL_CONFIGS", configs })

    expect(next.activeModelId).toBeNull()
    expect(next.sessions[0].composerPreferences?.modelId).toBeNull()
  })

  test("startup selects the newest available session when the persisted session is stale", () => {
    const sessions = [
      { id: "newest", title: "Newest", agentId: "main-agent", createdAt: 2, updatedAt: 2, archived: 0 },
      { id: "older", title: "Older", agentId: "main-agent", createdAt: 1, updatedAt: 1, archived: 0 },
    ]
    const state = {
      sessions: [],
      activeSessionId: "deleted-session",
      activeModelId: null,
      systemSettings: { restoreLastSession: true },
    } as unknown as AppState

    const next = appReducer(state, { type: "SET_SESSIONS", sessions })

    expect(next.activeSessionId).toBe("newest")
  })

  test("run state is session-scoped when switching conversations", () => {
    let state = {
      sessions: [
        { id: "session-a", title: "A", agentId: "main-agent", createdAt: 1, updatedAt: 1 },
        { id: "session-b", title: "B", agentId: "main-agent", createdAt: 2, updatedAt: 2 },
      ],
      activeSessionId: "session-a",
      activeModelId: null,
      sessionRestoreNonce: 0,
      runsBySession: {},
      isStreaming: false,
      buildLogsBySession: {},
      agentLogsBySession: {},
    } as unknown as AppState
    state = appReducer(state, {
      type: "UPSERT_SESSION_RUN",
      run: {
        sessionId: "session-a",
        requestId: "request-a",
        taskId: "task-a",
        status: "running",
        startedAt: 1,
        updatedAt: 1,
      },
    })
    expect(state.isStreaming).toBe(true)

    state = appReducer(state, { type: "SET_ACTIVE_SESSION", sessionId: "session-b" })
    expect(state.isStreaming).toBe(false)
    expect(state.runsBySession["session-a"]?.taskId).toBe("task-a")

    state = appReducer(state, { type: "SET_ACTIVE_SESSION", sessionId: "session-a" })
    expect(state.isStreaming).toBe(true)

    state = appReducer(state, {
      type: "UPSERT_SESSION_RUN",
      run: {
        sessionId: "session-a",
        requestId: "request-new",
        taskId: "task-new",
        status: "running",
        startedAt: 2,
        updatedAt: 2,
      },
    })
    state = appReducer(state, {
      type: "SET_STREAMING",
      streaming: false,
      sessionId: "session-a",
      taskId: "task-a",
    })
    expect(state.isStreaming).toBe(true)
    expect(state.runsBySession["session-a"]?.taskId).toBe("task-new")
  })

  test("server command synchronization preserves unresolved work until its SSE terminal", () => {
    const local = {
      id: "local",
      requestId: "local",
      sessionId: "session-a",
      text: "local",
      attachments: [],
      scope: "auto-edit" as const,
      effort: "on" as const,
      modelId: null,
      workingDir: null,
      serverState: "local" as const,
      createdAt: 1,
    }
    const stale = { ...local, id: "stale", requestId: "stale", serverState: "pending" as const }
    const accepted = {
      ...local,
      id: "accepted",
      requestId: "accepted",
      serverState: "accepted" as const,
      taskId: "task-a",
      createdAt: 2,
    }
    const state = {
      instructionQueue: [local, stale],
    } as unknown as AppState

    const next = appReducer(state, {
      type: "SYNC_SERVER_COMMANDS",
      instructions: [accepted],
    })
    expect(next.instructionQueue.map((item) => item.requestId)).toEqual(["local", "stale", "accepted"])
    expect(next.instructionQueue.find((item) => item.requestId === "accepted")?.taskId).toBe("task-a")
    expect(next.sessionCommandsHydrated).toBe(true)
  })

  test("clear resets the active UI aggregate and rejects stale queue projections", () => {
    const staleInstruction = {
      id: "stale",
      requestId: "stale",
      sessionId: "session-a",
      text: "old task",
      attachments: [],
      scope: "auto-edit" as const,
      effort: "on" as const,
      modelId: null,
      workingDir: null,
      serverState: "pending" as const,
      createdAt: 10,
    }
    let state: AppState = {
      ...createInitialState(),
      sessions: [{ id: "session-a", title: "A", agentId: "main-agent", createdAt: 1, updatedAt: 1 }],
      activeSessionId: "session-a",
      messages: [{ role: "user", content: "old", timestamp: 1 }],
      isStreaming: true,
      isCompacting: true,
      streamStartedAt: 1,
      toolStatus: { name: "read" },
      agentProgress: { phase: "tools", step: 1, maxSteps: 2 },
      workLog: [{ id: "w", type: "execute", label: "run", timestamp: 1, status: "running" }],
      todos: [{ content: "old", status: "pending", priority: "high" }],
      schematics: [{ analysis: "old", filePath: "old.pdf" }],
      artifactRevision: 2,
      pendingApprovals: [{ kind: "approval", id: "a", sessionId: "session-a", toolName: "bash", reason: "r", target: "t", createdAt: 1, expiresAt: 2 }],
      pendingQuestions: [{ kind: "question", id: "q", sessionId: "session-a", question: "q", options: [], allowCustom: true, createdAt: 1 }],
      instructionQueue: [staleInstruction],
      runsBySession: { "session-a": { sessionId: "session-a", requestId: "stale", status: "running", startedAt: 1, updatedAt: 1 } },
      buildOutput: [{ text: "old", type: "info", timestamp: 1 }],
      buildLogsBySession: { "session-a": [{ text: "old", type: "info", timestamp: 1 }] },
      agentLogsBySession: { "session-a": [{ text: "old", type: "info", timestamp: 1 }] },
    }

    state = appReducer(state, {
      type: "CLEAR_SESSION_CONVERSATION",
      sessionId: "session-a",
      artifactRevision: 3,
      clearedAt: 20,
    })

    expect(state.messages).toEqual([])
    expect(state.isStreaming).toBe(false)
    expect(state.instructionQueue).toEqual([])
    expect(state.runsBySession["session-a"]).toBeUndefined()
    expect(state.pendingApprovals).toEqual([])
    expect(state.pendingQuestions).toEqual([])
    expect(state.artifactRevision).toBe(3)
    expect(state.sessionRestoreNonce).toBe(1)

    state = appReducer(state, {
      type: "SYNC_SERVER_COMMANDS",
      instructions: [staleInstruction],
    })
    expect(state.instructionQueue).toEqual([])
    state = appReducer(state, {
      type: "UPSERT_SESSION_RUN",
      run: { sessionId: "session-a", requestId: "stale", status: "running", startedAt: 10, updatedAt: 21 },
    })
    state = appReducer(state, {
      type: "SET_PENDING_QUESTIONS",
      questions: [{ kind: "question", id: "stale-q", sessionId: "session-a", question: "old", options: [], allowCustom: true, createdAt: 10 }],
    })
    expect(state.runsBySession["session-a"]).toBeUndefined()
    expect(state.pendingQuestions).toEqual([])
  })

  test("one request projects one user bubble across pending poll and transport reattach", () => {
    let state = {
      messages: [],
    } as unknown as AppState
    const first = {
      role: "user" as const,
      requestId: "request-pdf",
      content: "请看一下这个文档，主要讲了什么",
      agentId: "auto",
      timestamp: 1,
      attachments: [{ name: "kimi技术报告.pdf", kind: "binary" }],
    }
    state = appReducer(state, { type: "UPSERT_REQUEST_MESSAGE", message: first })
    state = appReducer(state, {
      type: "UPSERT_REQUEST_MESSAGE",
      message: {
        ...first,
        timestamp: 2,
        attachments: [],
      },
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.requestId).toBe("request-pdf")
    expect(state.messages[0]?.attachments).toEqual(first.attachments)
  })

  test("identical text from two request ids remains two user turns", () => {
    let state = {
      messages: [],
    } as unknown as AppState
    for (const requestId of ["request-a", "request-b"]) {
      state = appReducer(state, {
        type: "UPSERT_REQUEST_MESSAGE",
        message: {
          role: "user",
          requestId,
          content: "请继续",
          timestamp: 1,
        },
      })
    }
    expect(state.messages.map((message) => message.requestId)).toEqual([
      "request-a",
      "request-b",
    ])
  })

  test("one attachment turn remains singular under 1000 poll and reconnect projections", () => {
    let state = {
      messages: [],
    } as unknown as AppState
    for (let attempt = 0; attempt < 1_000; attempt++) {
      state = appReducer(state, {
        type: "UPSERT_REQUEST_MESSAGE",
        message: {
          role: "user",
          requestId: "request-stress",
          content: "请读取附件",
          timestamp: attempt,
          attachments: attempt === 0
            ? [{ name: "report.pdf", kind: "binary" }]
            : [],
        },
      })
    }
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.attachments).toEqual([
      { name: "report.pdf", kind: "binary" },
    ])
  })

  test("conversation history restores even when an auxiliary panel request fails", async () => {
    const actions: Array<{ type: string; [key: string]: unknown }> = []
    let messageAttempts = 0
    const fetcher = async (path: string): Promise<Response> => {
      if (path.startsWith("/api/messages")) {
        messageAttempts++
        if (messageAttempts === 1) return new Response("temporary", { status: 503 })
        return Response.json([
          { role: "user", content: "last question", agent_id: "main-agent", seq: 1, timestamp: 1 },
          { role: "assistant", content: "last answer", agent_id: "main-agent", seq: 2, timestamp: 2 },
        ])
      }
      if (path.startsWith("/api/tasks/logs")) return new Response("temporary", { status: 503 })
      if (path.startsWith("/api/tool-executions")) return Response.json({ executions: [] })
      if (path.startsWith("/api/tasks?")) {
        return Response.json({
          approvals: [],
          questions: [],
          tasks: [{
            id: "task-running",
            requestId: "request-running",
            sessionId: "session-1",
            status: "running",
            createdAt: 10,
            startedAt: 11,
          }],
          execution: {
            state: "completed",
            todos: [{ content: "代码审查", status: "completed", priority: "high" }],
            followups: [{
              content: "连接 J-Link 后做实机验证",
              owner: "user",
              category: "hardware-validation",
            }],
          },
        })
      }
      if (path.startsWith("/api/sessions/artifacts")) {
        return Response.json({ artifactRevision: 0, schematics: [], documents: [] })
      }
      if (path.startsWith("/api/build/logs")) return Response.json({ events: [] })
      return new Response("not found", { status: 404 })
    }

    const result = await restoreSession(
      { id: "session-1", title: "Session", agentId: "main-agent", createdAt: 1, updatedAt: 1 },
      (action) => actions.push(action as typeof actions[number]),
      () => true,
      { fetcher, retryDelaysMs: [0, 0], requestTimeoutMs: 100 },
    )

    expect(result.messagesRestored).toBe(true)
    expect(result.auxiliaryFailures).toBe(1)
    expect(messageAttempts).toBe(2)
    expect(actions.find((action) => action.type === "SET_MESSAGES")?.messages).toEqual([
      { role: "user", content: "last question", agentId: "main-agent", seq: 1, timestamp: 1 },
      { role: "assistant", content: "last answer", agentId: "main-agent", seq: 2, timestamp: 2 },
    ])
    expect(actions.filter((action) => action.type === "SET_FOLLOWUPS").at(-1)?.followups).toEqual([{
      content: "连接 J-Link 后做实机验证",
      owner: "user",
      category: "hardware-validation",
    }])
    expect(actions.find((action) => action.type === "UPSERT_SESSION_RUN")?.run).toMatchObject({
      sessionId: "session-1",
      requestId: "request-running",
      taskId: "task-running",
      status: "running",
    })
  })

  test("restored activity is scoped to the latest root run instead of the whole session", async () => {
    const actions: Array<{ type: string; [key: string]: unknown }> = []
    let executionRequest = ""
    const fetcher = async (path: string): Promise<Response> => {
      if (path.startsWith("/api/messages")) return Response.json([])
      if (path.startsWith("/api/tasks?")) {
        return Response.json({
          approvals: [],
          questions: [],
          tasks: [
            {
              id: "task-current",
              requestId: "request-current",
              sessionId: "session-activity",
              status: "failed",
              createdAt: 20,
              completedAt: 30,
            },
            {
              id: "task-old",
              requestId: "request-old",
              sessionId: "session-activity",
              status: "completed",
              createdAt: 1,
              completedAt: 10,
            },
          ],
          execution: { state: "failed", todos: [], followups: [] },
        })
      }
      if (path.startsWith("/api/tool-executions")) {
        executionRequest = path
        return Response.json({
          executions: [{
            kind: "tool-execution",
            id: "execution-current",
            toolName: "read",
            status: "succeeded",
            linesAdded: 0,
            linesRemoved: 0,
            reversible: false,
            startedAt: 25,
          }],
        })
      }
      if (path.startsWith("/api/sessions/artifacts")) {
        return Response.json({ artifactRevision: 0, schematics: [], documents: [] })
      }
      if (path.startsWith("/api/tasks/logs")) return Response.json({ events: [] })
      if (path.startsWith("/api/build/logs")) return Response.json({ events: [] })
      return new Response("not found", { status: 404 })
    }

    await restoreSession(
      { id: "session-activity", title: "Session", agentId: "main-agent", createdAt: 1, updatedAt: 1 },
      (action) => actions.push(action as typeof actions[number]),
      () => true,
      { fetcher, retryDelaysMs: [0], requestTimeoutMs: 100 },
    )

    expect(executionRequest).toContain("runId=task-current")
    expect(actions.find((action) => action.type === "SET_WORK_LOG")?.entries)
      .toEqual([expect.objectContaining({ id: "log-execution-current" })])
  })

  test("completed root runs retain failed attempts only as recovered diagnostics", async () => {
    const actions: Array<{ type: string; [key: string]: unknown }> = []
    const fetcher = async (path: string): Promise<Response> => {
      if (path.startsWith("/api/messages")) return Response.json([])
      if (path.startsWith("/api/tasks?")) {
        return Response.json({
          approvals: [],
          questions: [],
          tasks: [{
            id: "task-completed",
            requestId: "request-completed",
            sessionId: "session-completed",
            status: "completed",
            createdAt: 10,
            completedAt: 20,
          }],
          execution: { state: "completed", todos: [], followups: [] },
        })
      }
      if (path.startsWith("/api/tool-executions")) {
        return Response.json({
          executions: [{
            kind: "tool-execution",
            id: "execution-denied",
            toolName: "bash",
            status: "denied",
            linesAdded: 0,
            linesRemoved: 0,
            reversible: false,
            startedAt: 12,
          }],
        })
      }
      if (path.startsWith("/api/sessions/artifacts")) {
        return Response.json({ artifactRevision: 0, schematics: [], documents: [] })
      }
      if (path.startsWith("/api/tasks/logs")) return Response.json({ events: [] })
      if (path.startsWith("/api/build/logs")) return Response.json({ events: [] })
      return new Response("not found", { status: 404 })
    }

    await restoreSession(
      { id: "session-completed", title: "Session", agentId: "main-agent", createdAt: 1, updatedAt: 1 },
      (action) => actions.push(action as typeof actions[number]),
      () => true,
      { fetcher, retryDelaysMs: [0], requestTimeoutMs: 100 },
    )

    expect(actions.find((action) => action.type === "SET_WORK_LOG")?.entries)
      .toEqual([expect.objectContaining({ id: "log-execution-denied", status: "error", recovered: true })])
  })
})
