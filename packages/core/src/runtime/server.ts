/**
 * HTTP + SSE Server
 *
 * 端点:
 *   POST /api/chat          SSE 流式对话
 *   GET  /api/sessions      会话列表
 *   POST /api/sessions      创建会话
 *   GET  /api/agents        Agent 列表
 *   GET  /api/models        模型列表 + 预设
 *   PUT  /api/models        保存模型配置
 *   POST /api/models/import 导入模型配置
 *   GET  /api/settings      系统设置
 *   PUT  /api/settings      保存系统设置
 *   POST /api/search/test   测试搜索提供商
 *   GET  /api/usage         用量统计
 *   GET  /api/logs          调用日志
 *   GET  /api/model-attempts 按运行查询真实模型尝试
 *   GET  /api/orchestration/logs 多 Agent 编排日志
 *   GET  /api/tasks         任务队列
 *   GET  /api/health        健康检查
 */
import { AgentLoop } from "./agent-loop"
import { ToolRegistry } from "../tool/registry"
import { AgentRegistry } from "../agent/registry"
import { MAIN_AGENT_ID } from "../agent/definitions/main-agent"
import { ModelRouter } from "../model-router/index"
import { configStore, normalizeModelConfigs, PRESETS } from "./config-store"
import { llmManager } from "./llm-manager"
import { taskScheduler } from "./task-scheduler"
import { SessionRepo, MessageRepo, ProjectRepo } from "../store/repository"
import { assistantPartsForRequest } from "./assistant-message-parts.ts"
import { SessionCommandRepo } from "../store/session-command.ts"
import { TokenUsageRepo } from "../store/token-usage.ts"
import { TaskRunRepo } from "../store/task-run.ts"
import { loadProjectConfig, saveProjectConfig } from "../store/project-config"
import { serialList, serialMonitor, serialSend } from "../tool/hardware/serial-port"
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { AgentOrchestrator } from "./orchestrator"
import { ragEngine } from "./rag"
import { handleTestConnection } from "./server-test-connection"
import { summarizeTranscript } from "./server-summary"
import { handleChat } from "./server-chat"
import { startSessionCommandDispatcher } from "./session-command-dispatcher.ts"
import { publicAttachmentSummaries } from "./session-command-projection.ts"
import { currentFileHash } from "./session-artifact-projection.ts"
import { deliveredFilesForRequest } from "./delivered-files.ts"
import { MAX_ATTACHMENT_UPLOAD_BODY_BYTES } from "./server-attachments.ts"
import { json } from "./server-response"
import { getSystemSettings, reconcileSystemSettingsReferences, saveSystemSettings, type SystemSettingReferences } from "./system-settings"
import {
  deleteProjectSettings, getEffectiveSystemSettings, getProjectSettings, importProjectSettings,
  listProjectSettings, reconcileProjectSettingsReferences, saveProjectSettings,
} from "./project-settings"
import { toolApprovalManager } from "./tool-approval"
import { userQuestionManager } from "./user-question"
import { runtimeAccessManager } from "./runtime-access"
import { clearCommunityToken, hasCommunityToken, setCommunityToken } from "./community-credentials"
import { normalizeScope } from "./tool-policy"
import {
  parseSessionComposerPreferencePatch,
  projectSessionComposerPreferences,
  resolveInitialSessionComposerPreferences,
} from "./session-composer-preferences.ts"
import {
  ToolExecutionConflictError, ToolExecutionNotFoundError, ToolExecutionRepo,
} from "../store/tool-execution"
import { projectPublicToolExecution, projectPublicToolExecutions } from "./public-tool-execution.ts"
import type { ModelConfig } from "../model-router/types"
import { handleTaskRoutes, publicRunGraph, publicRunGraphEvents } from "./server-tasks"
import { buildToolCatalog, testManagedTool } from "./tool-management"
import { deleteSkill, installSkill, listManagedSkills } from "../skills/manager"
import { applyCustomAgents, loadCustomAgents, normalizeCustomAgents, saveCustomAgents } from "../agent/custom-agents"
import { mcpManager } from "../mcp/manager"
import type { WorkflowEngine } from "./workflow-engine"
import { handleWorkflowRoutes } from "./server-workflows"
import { executeShellCommand } from "../tool/shell-executor"
import { RUNTIME_PROTOCOL_VERSION } from "./runtime-protocol.ts"
import { buildAgentHistory, estimateTokens } from "./context-compaction.ts"
import { redactInternalImplementationDetails } from "./model-output-policy.ts"
import { OrchestrationLogRepo } from "../store/orchestration-log.ts"
import { RunContractRepo } from "../store/run-contract.ts"
import { RunGraphRepo } from "../store/run-graph.ts"
import { projectSessionArtifacts, SessionArtifactRepo } from "../store/session-artifact.ts"
import { handleProgrammerRoute } from "./server-programmer.ts"
import { buildDiagnosticsSnapshot } from "./server-diagnostics.ts"
import { getCors, hasValidToken, isAllowedOrigin } from "./server-security.ts"
import {
  createServerSessionLifecycleManager,
  lifecycleResponse,
  purgeSessionAggregate,
  sessionMutationTarget,
} from "./server-session-lifecycle.ts"

// ══════════════════════════════════════════════
// 依赖注入
// ══════════════════════════════════════════════

let agentLoop: AgentLoop | null = null
let toolRegistry: ToolRegistry | null = null
let agentRegistry: AgentRegistry | null = null
let modelRouter: ModelRouter | null = null
let orchestrator: AgentOrchestrator | null = null
let workflowEngine: WorkflowEngine | null = null

const sessionLifecycleManager = createServerSessionLifecycleManager(() => workflowEngine)

export function inject(ctx: {
  agentLoop: AgentLoop; toolRegistry: ToolRegistry; agentRegistry: AgentRegistry
  modelRouter: ModelRouter; orchestrator: AgentOrchestrator; workflowEngine: WorkflowEngine
}) {
  agentLoop = ctx.agentLoop; toolRegistry = ctx.toolRegistry
  agentRegistry = ctx.agentRegistry; modelRouter = ctx.modelRouter
  orchestrator = ctx.orchestrator
  workflowEngine = ctx.workflowEngine
  const chatDependencies = { agentLoop, toolRegistry, agentRegistry, modelRouter, orchestrator }
  startSessionCommandDispatcher((request) => handleChat(request, {}, chatDependencies))
}

function reconcilePersistedSettingReferences(references: SystemSettingReferences): void {
  saveSystemSettings(reconcileSystemSettingsReferences(getSystemSettings(), references))
  reconcileProjectSettingsReferences(references)
}

function currentModelReferenceIds(): Set<string> {
  const ids = new Set<string>()
  for (const model of modelRouter?.configuredList ?? []) {
    ids.add(model.id)
    ids.add(model.modelId)
    const match = model.id.match(/^@([^:]+)::/)
    if (match) ids.add(match[1])
  }
  return ids
}

function validDirectory(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) return null
  try {
    const path = resolve(value)
    return statSync(path).isDirectory() ? path : null
  } catch {
    return null
  }
}

// ══════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════

export async function handleRequest(req: Request): Promise<Response> {
  const cors = getCors(req)
  if (!isAllowedOrigin(req)) return json({ error: "Origin 不允许" }, { ...cors, status: 403 })
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
  if (!hasValidToken(req)) return json({ error: "未授权" }, { ...cors, status: 401 })

  const u = new URL(req.url)
  const p = u.pathname
  const contentLength = Number(req.headers.get("content-length") ?? "0")
  const requestBodyLimit = p === "/api/attachments"
    ? MAX_ATTACHMENT_UPLOAD_BODY_BYTES
    : 10 * 1024 * 1024
  if (Number.isFinite(contentLength) && contentLength > requestBodyLimit) {
    const maximum = requestBodyLimit / (1024 * 1024)
    return json({ error: `请求体过大（最大 ${maximum}MB）` }, { ...cors, status: 413 })
  }

  try {
    const mutatingSessionId = await sessionMutationTarget(req, u)
    if (mutatingSessionId && sessionLifecycleManager.isTerminating(mutatingSessionId)) {
      return json({
        error: "会话正在终止，不能接受新的执行命令",
        lifecycle: sessionLifecycleManager.getState(mutatingSessionId),
      }, { ...cors, status: 409 })
    }
    const taskResponse = await handleTaskRoutes(req, u, cors)
    if (taskResponse) return taskResponse
    const workflowResponse = await handleWorkflowRoutes(req, u, cors, workflowEngine)
    if (workflowResponse) return workflowResponse

    // ── 模型配置 ──
    if (p === "/api/models" && req.method === "GET") {
      const models = configStore.load().map((model) => ({
        ...model,
        apiKey: "",
        hasApiKey: Boolean(model.apiKey),
      }))
      return json({ models, presets: Object.keys(PRESETS), credentialStore: configStore.credentialBackend() }, cors)
    }
    if (p === "/api/models/validate" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const configs = body.models as ModelConfig[]
      const error = validateModelPayload(configs)
      return error ? json({ error }, { ...cors, status: 400 }) : json({ success: true }, cors)
    }
    if (p === "/api/models" && req.method === "PUT") {
      const body = await req.json().catch(() => ({}))
      const configs = body.models as ModelConfig[]
      const validationError = validateModelPayload(configs)
      if (validationError) return json({ error: validationError }, { ...cors, status: 400 })
      // 前端脱敏了 apiKey（空值）；为空时保留后端已存的密钥，避免误清空
      const clearApiKeyIds = new Set(configs
        .filter((model) => Boolean((model as ModelConfig & { clearApiKey?: boolean }).clearApiKey))
        .map((model) => model.id))
      const existing = configStore.load()
      const existingKeys = new Map(existing.map((m) => [m.id, m.apiKey]))
      for (const c of configs) {
        if (clearApiKeyIds.has(c.id)) c.apiKey = ""
        else if (!c.apiKey) c.apiKey = existingKeys.get(c.id) ?? ""
      }
      const ok = configStore.save(configs, { clearApiKeyIds })
      if (!ok) return json({ error: "配置保存失败" }, { ...cors, status: 500 })
      modelRouter?.updateModels(configStore.load())
      reconcilePersistedSettingReferences({ modelIds: currentModelReferenceIds() })
      return json({ success: true, count: configs.length }, cors)
    }
    if (p === "/api/models/import" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const result = configStore.import(body.json ?? JSON.stringify(body))
      if (!result) return json({ error: "JSON 格式无效" }, { ...cors, status: 400 })
      modelRouter?.updateModels(result)
      reconcilePersistedSettingReferences({ modelIds: currentModelReferenceIds() })
      return json({ success: true, count: result.length }, cors)
    }
    if (p === "/api/models/preset" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const existing = configStore.load()
      const merged = configStore.applyPreset(body.preset, existing)
      if (!configStore.save(merged)) return json({ error: "预设配置保存失败" }, { ...cors, status: 500 })
      modelRouter?.updateModels(configStore.load())
      reconcilePersistedSettingReferences({ modelIds: currentModelReferenceIds() })
      return json({ success: true, count: merged.length }, cors)
    }

    // ── 系统设置 ──
    if (p === "/api/settings" && req.method === "GET") {
      return json({ settings: getSystemSettings() }, cors)
    }
    if (p === "/api/settings" && req.method === "PUT") {
      const body = await req.json().catch(() => ({}))
      const settings = saveSystemSettings(body.settings)
      return json({ success: true, settings }, cors)
    }
    if (p === "/api/runtime/community-session" && req.method === "GET") {
      return json({ connected: hasCommunityToken() }, cors)
    }
    if (p === "/api/runtime/community-session" && req.method === "PUT") {
      const body = await req.json().catch(() => ({})) as { token?: unknown }
      try {
        setCommunityToken(body.token)
        return json({ success: true, connected: true }, cors)
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 400 })
      }
    }
    if (p === "/api/runtime/community-session" && req.method === "DELETE") {
      clearCommunityToken()
      return new Response(null, { status: 204, headers: cors })
    }
    if (p === "/api/tools" && req.method === "GET") {
      if (!toolRegistry) return json({ error: "工具系统未初始化" }, { ...cors, status: 503 })
      const requested = u.searchParams.get("projectPath")
      const projectPath = requested ? validDirectory(requested) ?? undefined : undefined
      if (requested && !projectPath) return json({ error: "projectPath 不是有效目录" }, { ...cors, status: 400 })
      return json({ tools: buildToolCatalog(toolRegistry, projectPath) }, cors)
    }
    if (p === "/api/tools/test" && req.method === "POST") {
      if (!toolRegistry) return json({ error: "工具系统未初始化" }, { ...cors, status: 503 })
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const projectPath = validDirectory(body.projectPath ?? process.cwd())
      if (!projectPath || typeof body.toolName !== "string" || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
        return json({ error: "缺少有效的 toolName、params 或 projectPath" }, { ...cors, status: 400 })
      }
      try {
        const result = await testManagedTool(
          toolRegistry,
          { toolName: body.toolName, params: body.params as Record<string, unknown>, projectPath },
          modelRouter ?? undefined,
        )
        return result.success ? json({ success: true, result: result.data }, cors) : json({ error: result.error ?? "工具测试失败", details: result.data }, { ...cors, status: 502 })
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 400 }) }
    }
    if (p === "/api/skills" && req.method === "GET") {
      const requested = u.searchParams.get("projectPath")
      const projectPath = requested ? validDirectory(requested) ?? undefined : undefined
      if (requested && !projectPath) return json({ error: "projectPath 不是有效目录" }, { ...cors, status: 400 })
      const settings = getEffectiveSystemSettings(projectPath)
      return json({ skills: listManagedSkills(projectPath, settings.disabledSkillIds) }, cors)
    }
    if (p === "/api/skills/install" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const target = body.target === "project" ? "project" : "user"
      const projectPath = target === "project" ? validDirectory(body.projectPath) ?? undefined : undefined
      if (target === "project" && !projectPath) return json({ error: "项目 Skill 需要有效的 projectPath" }, { ...cors, status: 400 })
      try {
        const skill = await installSkill({
          target, projectPath,
          location: typeof body.location === "string" ? body.location : undefined,
          content: typeof body.content === "string" ? body.content : undefined,
        })
        return json({ success: true, skill: { ...skill, content: undefined } }, cors)
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 400 }) }
    }
    if (p === "/api/skills" && req.method === "DELETE") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const projectPath = typeof body.projectPath === "string" ? validDirectory(body.projectPath) ?? undefined : undefined
      if (typeof body.path !== "string") return json({ error: "缺少 Skill path" }, { ...cors, status: 400 })
      try { deleteSkill(body.path, projectPath); return json({ success: true }, cors) }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 400 }) }
    }
    if (p === "/api/custom-agents" && req.method === "GET") {
      if (!toolRegistry) return json({ error: "工具系统未初始化" }, { ...cors, status: 503 })
      return json({ agents: loadCustomAgents(toolRegistry) }, cors)
    }
    if (p === "/api/custom-agents" && req.method === "PUT") {
      if (!toolRegistry || !agentRegistry) return json({ error: "Agent 系统未初始化" }, { ...cors, status: 503 })
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      try {
        const agents = saveCustomAgents(body.agents, toolRegistry)
        applyCustomAgents(agentRegistry, toolRegistry, agents)
        reconcilePersistedSettingReferences({ agentIds: new Set(agentRegistry.list().map((agent) => agent.id)) })
        return json({ success: true, agents }, cors)
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 400 }) }
    }
    if (p === "/api/mcp/servers" && req.method === "GET") {
      const requested = u.searchParams.get("projectPath")
      const projectPath = requested ? validDirectory(requested) ?? undefined : undefined
      if (requested && !projectPath) return json({ error: "projectPath 不是有效目录" }, { ...cors, status: 400 })
      return json({ servers: mcpManager.list(projectPath) }, cors)
    }
    if (p === "/api/mcp/servers" && req.method === "PUT") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      try { return json({ success: true, servers: await mcpManager.save(body.servers) }, cors) }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 400 }) }
    }
    if (p === "/api/mcp/validate" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      try { mcpManager.validate(body.servers); return json({ success: true }, cors) }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 400 }) }
    }
    if (p === "/api/mcp/connect" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (typeof body.id !== "string") return json({ error: "缺少 MCP 服务 ID" }, { ...cors, status: 400 })
      try {
        if (body.action === "stop") return json({ success: true, server: await mcpManager.setEnabled(body.id, false) }, cors)
        return json({ success: true, server: await mcpManager.setEnabled(body.id, true) }, cors)
      } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 502 }) }
    }
    if (p === "/api/project-settings" && req.method === "GET") {
      const projectPath = validDirectory(u.searchParams.get("projectPath"))
      if (!projectPath) return json({ error: "projectPath 不是有效目录" }, { ...cors, status: 400 })
      const record = getProjectSettings(projectPath)
      return json({ projectPath, overrides: record?.overrides ?? {}, effective: getEffectiveSystemSettings(projectPath), updatedAt: record?.updatedAt ?? null }, cors)
    }
    if (p === "/api/project-settings" && req.method === "PUT") {
      const body = await req.json().catch(() => ({})) as { projectPath?: unknown; overrides?: unknown }
      const projectPath = validDirectory(body.projectPath)
      if (!projectPath) return json({ error: "projectPath 不是有效目录" }, { ...cors, status: 400 })
      const record = saveProjectSettings(projectPath, body.overrides)
      return json({ success: true, ...record, effective: getEffectiveSystemSettings(projectPath) }, cors)
    }
    if (p === "/api/project-settings" && req.method === "DELETE") {
      const projectPath = validDirectory(u.searchParams.get("projectPath"))
      if (!projectPath) return json({ error: "projectPath 不是有效目录" }, { ...cors, status: 400 })
      deleteProjectSettings(projectPath)
      return json({ success: true, effective: getSystemSettings() }, cors)
    }
    if (p === "/api/search/test" && req.method === "POST") {
      const settings = getSystemSettings()
      if (!toolRegistry) return json({ error: "工具系统未初始化" }, { ...cors, status: 503 })
      const body = await req.json().catch(() => ({})) as { query?: unknown; provider?: unknown; timeoutMs?: unknown }
      const query = typeof body.query === "string" && body.query.trim() ? body.query.trim().slice(0, 100) : "OpenAI"
      const providers = ["auto", "duckduckgo", "bing", "google-news"] as const
      const provider = providers.includes(body.provider as typeof providers[number]) ? body.provider as typeof providers[number] : settings.searchProvider
      const timeoutMs = Math.min(30_000, Math.max(3_000, Number.isFinite(Number(body.timeoutMs)) ? Math.round(Number(body.timeoutMs)) : settings.searchTimeoutMs))
      const result = await toolRegistry.execute("websearch", { query, maxResults: 1 }, {
        sessionId: "settings-search-test",
        agentId: "system",
        workingDir: process.cwd(),
        searchConfig: {
          provider,
          timeoutMs,
          maxResults: 1,
        },
      })
      return result.success
        ? json({ success: true, result: result.data }, cors)
        : json({ error: result.error ?? "搜索连接测试失败" }, { ...cors, status: 502 })
    }
    if (p === "/api/diagnostics" && req.method === "GET") {
      return json(buildDiagnosticsSnapshot(false, { toolRegistry, agentRegistry }), cors)
    }
    if (p === "/api/diagnostics/report" && req.method === "GET") {
      return json(buildDiagnosticsSnapshot(true, { toolRegistry, agentRegistry }), cors)
    }
    if (p === "/api/config/backup" && req.method === "GET") {
      return json({
        format: "eval-config-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: getSystemSettings(),
        projectSettings: listProjectSettings(),
        models: configStore.load().map((model) => ({ ...model, apiKey: "" })),
        customAgents: toolRegistry ? loadCustomAgents(toolRegistry) : [],
        mcpServers: mcpManager.load().map(({ env: _env, headers: _headers, ...server }) => server),
      }, cors)
    }
    if (p === "/api/config/restore" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (body.format !== "eval-config-backup" || body.version !== 1) {
        return json({ error: "不是受支持的 Eval 配置备份" }, { ...cors, status: 400 })
      }
      const importedModels = body.models === undefined ? null : normalizeModelConfigs(body.models)
      if (body.models !== undefined && !importedModels) return json({ error: "备份中的模型配置无效" }, { ...cors, status: 400 })
      if (body.customAgents !== undefined && toolRegistry) normalizeCustomAgents(body.customAgents, toolRegistry)
      if (body.mcpServers !== undefined) mcpManager.validate(body.mcpServers)

      const previous = {
        settings: getSystemSettings(), projectSettings: listProjectSettings(), models: configStore.load(),
        customAgents: toolRegistry ? loadCustomAgents(toolRegistry) : [], mcpServers: mcpManager.load(),
      }
      try {
        saveSystemSettings(body.settings)
        const projectCount = importProjectSettings(body.projectSettings)
        let modelCount = 0
        if (importedModels) {
          const existingKeys = new Map(previous.models.map((model) => [model.id, model.apiKey]))
          const models = importedModels.map((model) => ({ ...model, apiKey: existingKeys.get(model.id) ?? "" }))
          if (!configStore.save(models)) throw new Error("模型配置恢复失败")
          modelRouter?.updateModels(configStore.load())
          modelCount = models.length
        }
        if (body.customAgents !== undefined && toolRegistry && agentRegistry) {
          const agents = saveCustomAgents(body.customAgents, toolRegistry)
          applyCustomAgents(agentRegistry, toolRegistry, agents)
        }
        if (body.mcpServers !== undefined) await mcpManager.save(body.mcpServers)
        reconcilePersistedSettingReferences({
          modelIds: currentModelReferenceIds(),
          agentIds: agentRegistry ? new Set(agentRegistry.list().map((agent) => agent.id)) : undefined,
        })
        return json({ success: true, settings: getSystemSettings(), projectCount, modelCount }, cors)
      } catch (error) {
        try {
          saveSystemSettings(previous.settings)
          importProjectSettings(previous.projectSettings)
          configStore.save(previous.models)
          modelRouter?.updateModels(configStore.load())
          if (toolRegistry && agentRegistry) {
            const agents = saveCustomAgents(previous.customAgents, toolRegistry)
            applyCustomAgents(agentRegistry, toolRegistry, agents)
          }
          await mcpManager.save(previous.mcpServers)
        } catch (rollbackError) {
          console.error("配置恢复回滚失败:", rollbackError)
        }
        return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 500 })
      }
    }

    // ── Token 每日热力图（真实模型 Usage 账本） ──
    if (p === "/api/usage/heatmap" && req.method === "GET") {
      const requestedDays = Number.parseInt(u.searchParams.get("days") ?? "91", 10)
      const scope = u.searchParams.get("scope") === "session" ? "session" : "all"
      const sessionId = u.searchParams.get("sessionId")?.trim()
      if (scope === "session" && !sessionId) {
        return json({ error: "按会话统计 Token 时必须提供 sessionId" }, { ...cors, status: 400 })
      }
      try {
        return json(TokenUsageRepo.heatmap({
          days: Number.isFinite(requestedDays) ? requestedDays : 91,
          scope,
          sessionId,
        }), cors)
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          { ...cors, status: 400 },
        )
      }
    }

    // ── 用量统计 ──
    if (p === "/api/usage" && req.method === "GET") {
      return json({
        stats: llmManager.getUsageStats(),
        timeline: llmManager.getTokenTimeline(u.searchParams.get("hours") ? parseInt(u.searchParams.get("hours")!) : 24),
        errorRate: llmManager.getErrorRate(),
      }, cors)
    }

    // ── 调用日志 ──
    if (p === "/api/logs" && req.method === "GET") {
      const limit = u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit")!) : 50
      return json({ logs: llmManager.getCallLogs({ limit }) }, cors)
    }

    if (p === "/api/model-attempts" && req.method === "GET") {
      const runId = u.searchParams.get("runId")
      if (!runId) return json({ error: "缺少 runId 参数" }, { ...cors, status: 400 })
      const limit = u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit")!) : 200
      return json({ attempts: llmManager.getModelAttempts(runId, limit) }, cors)
    }

    // ── 多 Agent 编排日志 ──
    if (p === "/api/orchestration/logs" && req.method === "GET") {
      const limit = u.searchParams.get("limit") ? parseInt(u.searchParams.get("limit")!) : 200
      return json({
        logs: OrchestrationLogRepo.list({
          sessionId: u.searchParams.get("sessionId") ?? undefined,
          runId: u.searchParams.get("runId") ?? undefined,
          parentRunId: u.searchParams.get("parentRunId") ?? undefined,
          eventType: u.searchParams.get("eventType") ?? undefined,
          limit,
        }),
      }, cors)
    }

    const runContractMatch = p.match(/^\/api\/runs\/([^/]+)\/contract$/)
    if (runContractMatch && req.method === "GET") {
      const contract = RunContractRepo.get(decodeURIComponent(runContractMatch[1]!))
      return contract
        ? json({ contract }, cors)
        : json({ error: "运行契约不存在" }, { ...cors, status: 404 })
    }

    const runGraphMatch = p.match(/^\/api\/run-graphs\/([^/]+)$/)
    if (runGraphMatch && req.method === "GET") {
      const graph = RunGraphRepo.get(decodeURIComponent(runGraphMatch[1]!))
      return graph
        ? json({ graph: publicRunGraph(graph) }, cors)
        : json({ error: "RunGraph 不存在" }, { ...cors, status: 404 })
    }
    const runGraphEventsMatch = p.match(/^\/api\/run-graphs\/([^/]+)\/events$/)
    if (runGraphEventsMatch && req.method === "GET") {
      const graphId = decodeURIComponent(runGraphEventsMatch[1]!)
      const after = Number.parseInt(u.searchParams.get("afterVersion") ?? "0", 10)
      const graph = RunGraphRepo.get(graphId)
      return graph
        ? json({
            graphId,
            version: graph.version,
            events: publicRunGraphEvents(RunGraphRepo.eventsAfter(graphId, after)),
          }, cors)
        : json({ error: "RunGraph 不存在" }, { ...cors, status: 404 })
    }
    const runGraphStreamMatch = p.match(/^\/api\/run-graphs\/([^/]+)\/stream$/)
    if (runGraphStreamMatch && req.method === "GET") {
      const graphId = decodeURIComponent(runGraphStreamMatch[1]!)
      if (!RunGraphRepo.get(graphId)) {
        return json({ error: "RunGraph 不存在" }, { ...cors, status: 404 })
      }
      let cursor = Math.max(0, Number.parseInt(u.searchParams.get("afterVersion") ?? "0", 10) || 0)
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          let closed = false
          const send = (event: string, data: unknown, id?: number) => {
            if (closed) return
            try {
              controller.enqueue(encoder.encode(
                `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ))
            } catch { closed = true }
          }
          const flush = () => {
            for (const event of publicRunGraphEvents(RunGraphRepo.eventsAfter(graphId, cursor))) {
              cursor = event.version
              send("graph-event", event, event.version)
            }
          }
          flush()
          const poller = setInterval(flush, 500)
          const heartbeat = setInterval(() => send("heartbeat", { graphId, version: cursor }), 15_000)
          const close = () => {
            if (closed) return
            closed = true
            clearInterval(poller)
            clearInterval(heartbeat)
            try { controller.close() } catch {}
          }
          req.signal.addEventListener("abort", close, { once: true })
        },
      })
      return new Response(stream, {
        headers: {
          ...cors,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      })
    }


    if (p === "/api/approvals/respond" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { id?: unknown; decision?: unknown; approved?: unknown }
      const decision = typeof body.decision === "string"
        ? body.decision
        : typeof body.approved === "boolean" ? (body.approved ? "allow-once" : "deny") : null
      if (typeof body.id !== "string" || !["deny", "allow-once", "allow-all"].includes(String(decision))) {
        return json({ error: "缺少有效的 id 或 decision" }, { ...cors, status: 400 })
      }
      const pending = toolApprovalManager.get(body.id)
      if (pending && decision === "allow-all") runtimeAccessManager.allowAll(pending.sessionId)
      const approval = toolApprovalManager.respond(body.id, decision as "deny" | "allow-once" | "allow-all")
      if (!approval) return json({ error: "审批不存在或已经结束" }, { ...cors, status: 404 })
      return json({
        success: true,
        approvalId: approval.id,
        decision,
        scope: runtimeAccessManager.getScope(approval.sessionId, "auto-edit"),
      }, cors)
    }

    if (p === "/api/questions/respond" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { id?: unknown; answer?: unknown }
      if (typeof body.id !== "string" || typeof body.answer !== "string" || !body.answer.trim()) {
        return json({ error: "缺少有效的 id 或 answer" }, { ...cors, status: 400 })
      }
      const validation = userQuestionManager.validateAnswer(body.id, body.answer)
      if (!validation.valid) {
        if (validation.reason === "not-found") {
          return json({ error: "问题不存在或已经回答" }, { ...cors, status: 404 })
        }
        if (validation.reason === "invalid-choice") {
          return json({ error: "该问题只接受给定选项，请重新选择" }, { ...cors, status: 400 })
        }
        return json({ error: "答案不能为空" }, { ...cors, status: 400 })
      }
      const question = userQuestionManager.respond(body.id, body.answer)
      if (!question) return json({ error: "回答提交发生并发冲突，请重试" }, { ...cors, status: 409 })
      return json({ success: true, questionId: question.id }, cors)
    }

    if (p === "/api/questions/cancel" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { id?: unknown }
      if (typeof body.id !== "string") {
        return json({ error: "缺少有效的 id" }, { ...cors, status: 400 })
      }
      const question = userQuestionManager.cancel(body.id)
      if (!question) return json({ error: "问题不存在或已经结束" }, { ...cors, status: 404 })
      return json({ success: true, questionId: question.id, status: "cancelled" }, cors)
    }

    if (p === "/api/sessions/runtime-access" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { sessionId?: unknown; scope?: unknown }
      const scope = normalizeScope(body.scope)
      if (typeof body.sessionId !== "string" || !scope) {
        return json({ error: "缺少有效的 sessionId 或 scope" }, { ...cors, status: 400 })
      }
      const access = runtimeAccessManager.set(body.sessionId, scope)
      const approved = scope === "full-access"
        ? toolApprovalManager.approveSession(body.sessionId).map((item) => item.id)
        : []
      return json({ success: true, scope: access.scope, approveAll: access.approveAll, approved }, cors)
    }

    if (p === "/api/sessions/preferences" && req.method === "PATCH") {
      const parsed = parseSessionComposerPreferencePatch(
        await req.json().catch(() => null),
        modelRouter,
      )
      if ("error" in parsed) return json({ error: parsed.error }, { ...cors, status: 400 })
      if (!SessionRepo.get(parsed.sessionId)) return json({ error: "会话不存在" }, { ...cors, status: 404 })
      const session = SessionRepo.updateComposerPreferences(parsed.sessionId, parsed.fields)
      if (!session) return json({ error: "会话不存在" }, { ...cors, status: 404 })
      return json({ preferences: projectSessionComposerPreferences(session, modelRouter) }, cors)
    }

    // ── 工具执行历史与安全撤销 ──
    if (p === "/api/tool-executions" && req.method === "GET") {
      const sessionId = u.searchParams.get("sessionId")
      if (!sessionId) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
      const limit = Number.parseInt(u.searchParams.get("limit") ?? "100", 10)
      const runId = u.searchParams.get("runId")
      if (runId) {
        const root = TaskRunRepo.get(runId)
        if (!root || root.sessionId !== sessionId || root.parentRunId) {
          return json({ error: "根任务不存在或不属于当前会话" }, { ...cors, status: 404 })
        }
      }
      const executions = runId
        ? ToolExecutionRepo.listByRootRun(sessionId, runId, limit)
        : ToolExecutionRepo.listBySession(sessionId, limit)
      return json({ executions: projectPublicToolExecutions(executions) }, cors)
    }
    if (p === "/api/tool-executions/undo" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { id?: unknown }
      if (typeof body.id !== "string" || !body.id) {
        return json({ error: "缺少有效的 id" }, { ...cors, status: 400 })
      }
      try {
        const execution = projectPublicToolExecution(ToolExecutionRepo.undo(body.id))
        return json({ success: true, execution }, cors)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = error instanceof ToolExecutionNotFoundError ? 404
          : error instanceof ToolExecutionConflictError ? 409 : 500
        return json({ error: message }, { ...cors, status })
      }
    }

    // ── 原有端点 ──
    if (p === "/api/health" && req.method === "GET") {
      return json({
        status: "ok",
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        tools: toolRegistry?.list().length ?? 0,
        agents: agentRegistry?.list().length ?? 0,
        scheduler: taskScheduler.getStats(),
      }, cors)
    }
    if (p === "/api/test-connection" && req.method === "POST") {
      return handleTestConnection(req, cors, modelRouter)
    }
    if (p === "/api/agents" && req.method === "GET") {
      return json(agentRegistry?.list().map((a) => ({
        id: a.id, name: a.name, description: a.description, mode: a.mode, color: a.color,
        tools: a.tools, requiredCapabilities: a.requiredCapabilities, systemPrompt: a.systemPrompt,
        maxSteps: a.maxSteps, temperature: a.temperature, source: a.source ?? "builtin", projectPath: a.projectPath,
      })) ?? [], cors)
    }
    if (p === "/api/sessions" && req.method === "GET") {
      return json(SessionRepo.list().map((s) => {
        const artifacts = projectSessionArtifacts(SessionArtifactRepo.snapshot(s.id))
        return {
          id: s.id, title: s.title, agentId: s.agent_id, mainAgentInstanceId: s.main_agent_instance_id, projectPath: s.project_path,
          createdAt: s.created_at, updatedAt: s.updated_at, archived: s.archived, summary: s.summary,
          compactSummary: s.compact_summary ? JSON.parse(s.compact_summary) : null,
          composerPreferences: projectSessionComposerPreferences(s, modelRouter),
          lifecycle: sessionLifecycleManager.getState(s.id),
          ...artifacts,
        }
      }), cors)
    }
    if (p === "/api/sessions" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as Record<string, any>
      const requestedProjectPath = body.projectPath
      const projectPath = requestedProjectPath == null || requestedProjectPath === ""
        ? null
        : validDirectory(requestedProjectPath)
      if (requestedProjectPath != null && requestedProjectPath !== "" && !projectPath) {
        return json({ error: "projectPath 不是有效目录" }, { ...cors, status: 400 })
      }
      const defaults = getEffectiveSystemSettings(projectPath ?? undefined)
      const composerPreferences = resolveInitialSessionComposerPreferences(
        body.composerPreferences,
        defaults,
        modelRouter,
      )
      const id = randomUUID()
      const s = SessionRepo.create({
        id,
        title: body.title ?? `会话 ${SessionRepo.list().length + 1}`,
        agent_id: MAIN_AGENT_ID,
        project_path: projectPath,
        ...composerPreferences,
      })
      return json({
        id: s.id,
        title: s.title,
        agentId: s.agent_id,
        mainAgentInstanceId: s.main_agent_instance_id,
        projectPath: s.project_path,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        archived: s.archived,
        summary: s.summary,
        compactSummary: null,
        composerPreferences: projectSessionComposerPreferences(s, modelRouter),
        artifactRevision: 0,
        schematics: [],
        documents: [],
      }, { ...cors, status: 201 })
    }
    if (p === "/api/sessions" && req.method === "DELETE") {
      const id = u.searchParams.get("id")
      if (!id) return json({ error: "缺少 id 参数" }, { ...cors, status: 400 })
      if (!SessionRepo.get(id)) return json({ error: "会话不存在" }, { ...cors, status: 404 })
      const result = await sessionLifecycleManager.terminate({
        sessionId: id,
        mode: "delete",
        cleanup: () => {
          purgeSessionAggregate(id, true)
          runtimeAccessManager.clear(id)
          return { success: true }
        },
      })
      return lifecycleResponse(result, cors)
    }
    if (p === "/api/sessions/archive" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const id = body.sessionId as string
      if (!id) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
      const msgs = MessageRepo.getBySession(id)
      if (!msgs.length) return json({ error: "会话无消息" }, { ...cors, status: 400 })
      // 构建压缩 prompt
      const transcript = msgs.map(m => `[${m.role}]: ${m.content}`).join("\n")
      const summary = await summarizeTranscript(transcript, modelRouter)
      SessionRepo.archive(id, summary)
      return json({ success: true, summary }, cors)
    }
    if (p === "/api/sessions/unarchive" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const id = body.sessionId as string
      if (!id) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
      SessionRepo.unarchive(id)
      return json({ success: true }, cors)
    }
    if (p === "/api/sessions/compact" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const id = body.sessionId as string
      if (!id) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
      if (!SessionRepo.get(id)) return json({ error: "会话不存在" }, { ...cors, status: 404 })
      if (typeof body.summary !== "string") return json({ error: "summary 必须是字符串" }, { ...cors, status: 400 })
      const summary = body.summary.trim()
      if (summary.length > 200_000) return json({ error: "压缩摘要过长" }, { ...cors, status: 400 })
      // 架构原则：/compact 只压缩 LLM 上下文，不删除前端对话记录
      // 前端保留完整 messages（UI 显示），LLM 上下文通过 sessions.compact_summary 获取摘要
      if (summary) {
        const compactSummary = SessionRepo.setCompact(id, summary, {
          throughSeq: MessageRepo.latestSeq(id),
          mode: "manual",
        })
        const messageTokens = estimateTokens(buildAgentHistory(MessageRepo.getBySession(id), compactSummary))
        return json({ success: true, summary: compactSummary, contextEstimate: { messageTokens, timestamp: compactSummary.timestamp } }, cors)
      } else {
        SessionRepo.clearCompact(id)
      }
      return json({ success: true, summary: null }, cors)
    }
    if (p === "/api/sessions/clear" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const id = body.sessionId as string
      if (!id) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
      if (!SessionRepo.get(id)) return json({ error: "会话不存在" }, { ...cors, status: 404 })
      const result = await sessionLifecycleManager.terminate({
        sessionId: id,
        mode: "clear",
        cleanup: () => {
          purgeSessionAggregate(id, false)
          runtimeAccessManager.clear(id)
          return {
            success: true,
            ...projectSessionArtifacts(SessionArtifactRepo.snapshot(id)),
          }
        },
      })
      return lifecycleResponse(result, cors)
    }

    if (p === "/api/sessions/artifacts" && req.method === "GET") {
      const id = u.searchParams.get("sessionId")
      if (!id) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
      if (!SessionRepo.get(id)) return json({ error: "会话不存在" }, { ...cors, status: 404 })
      return json(projectSessionArtifacts(SessionArtifactRepo.snapshot(id), currentFileHash), cors)
    }
    if (p === "/api/sessions/artifacts" && req.method === "DELETE") {
      const id = u.searchParams.get("sessionId")
      const artifactId = u.searchParams.get("artifactId")
      if (!id || !artifactId) return json({ error: "缺少 sessionId 或 artifactId" }, { ...cors, status: 400 })
      return json(projectSessionArtifacts(SessionArtifactRepo.remove(id, artifactId), currentFileHash), cors)
    }
	    if (p === "/api/projects/init" && req.method === "POST") {
	      const body = await req.json().catch(() => ({}))
	      const projectPath = body.projectPath as string
	      if (!projectPath) return json({ error: "缺少 projectPath" }, { ...cors, status: 400 })
	      // 创建 .eval/ 目录
	      const evalDir = join(projectPath, ".eval")
	      if (!existsSync(evalDir)) mkdirSync(evalDir, { recursive: true })
	      // project.toml: 已有则不覆盖
	      const tomlPath = join(evalDir, "project.toml")
	      let config = loadProjectConfig(projectPath)
	      const projectName = body.name ?? projectPath.split(/[\\/]/).pop() ?? "untitled"
	      if (!existsSync(tomlPath)) {
	        const chip = typeof body.chip === "string" ? body.chip.trim() : ""
	        const chipFamily = typeof body.chipFamily === "string" ? body.chipFamily.trim() : ""
	        config = {
	          project: {
	            name: projectName,
	            chip,
	            chip_family: chipFamily,
	            target_confirmed: Boolean(chip),
	            target_evidence: chip ? "用户在项目初始化界面显式指定" : undefined,
	          },
	          build: { toolchain: body.toolchain ?? "arm-none-eabi-", build_system: "cmake" },
	          debug: { programmer: "", target_cfg: "" },
	        }
	        saveProjectConfig(projectPath, config)
	      }
	      // rules.md: 已有则不覆盖
	      const rulesPath = join(evalDir, "rules.md")
	      if (!existsSync(rulesPath)) {
	        const template = `# ${projectName} 规则\n\n<!-- 在此添加项目专属的 AI 编码规范和上下文信息 -->\n<!-- 例如：芯片手册地址、硬件连接说明、编码风格约定等 -->\n\n## 项目概述\n\n> 请在此处描述项目的基本信息和架构\n\n## 编码规范\n\n> 请在此处添加项目专属的编码规则\n\n## 硬件信息\n\n> 请在此处描述硬件平台、外设配置等\n`
	        writeFileSync(rulesPath, template, "utf-8")
	      }
	      // 同步到 DB projects 表
	      const existing = ProjectRepo.getByPath(projectPath)
	      if (!existing) {
	        ProjectRepo.create({
	          name: projectName,
	          path: projectPath,
	          chip: body.chip ?? null,
	          chip_family: body.chipFamily ?? null,
	          config: null,
	        })
	      }
	      return json({ ok: true, path: projectPath, config }, cors)
	    }
    if (p === "/api/archive/search" && req.method === "GET") {
      const q = u.searchParams.get("q") ?? ""
      if (!q.trim()) return json({ results: [] }, cors)
      const results = SessionRepo.searchSummaries(q.trim())
      return json({ results }, cors)
    }
    if (p === "/api/messages" && req.method === "GET") {
      const sid = u.searchParams.get("sessionId")
      if (!sid) return json({ error: "缺少 sessionId" }, { ...cors, status: 400 })
      // Public conversation history is intentionally separated from the model
      // transaction ledger. Tool protocol, reasoning replay data and raw results
      // remain server-side and must never leak into restored chat messages.
      return json(MessageRepo.getBySession(sid).map((message) => {
        const command = message.request_id
          ? SessionCommandRepo.get(message.request_id)
          : null
        return {
          id: message.id,
          session_id: message.session_id,
          requestId: message.request_id,
          role: message.role,
          content: message.role === "assistant"
            ? redactInternalImplementationDetails(message.content)
            : message.content,
          agent_id: message.agent_id,
          seq: message.seq,
          timestamp: message.timestamp,
          attachments: message.role === "user" && command
            ? publicAttachmentSummaries(command.payload)
            : [],
          deliveryFiles: message.role === "assistant" && message.request_id
            ? deliveredFilesForRequest(message.session_id, message.request_id)
            : [],
          parts: message.role === "assistant" && message.request_id
            ? assistantPartsForRequest(message.request_id)
            : [],
        }
      }), cors)
    }
    if (p === "/api/chat" && req.method === "POST") {
      return handleChat(req, cors, { agentLoop, agentRegistry, toolRegistry, modelRouter, orchestrator })
    }
    const programmerResponse = await handleProgrammerRoute(req, u, cors)
    if (programmerResponse) return programmerResponse

    if (p === "/api/rag/search" && req.method === "GET") {
      const q = u.searchParams.get("q") ?? ""
      const k = parseInt(u.searchParams.get("k") ?? "3")
      const projectDir = u.searchParams.get("projectDir")
      if (!q.trim() || !projectDir) return json({ error: "缺少 q 或 projectDir" }, { ...cors, status: 400 })
      try {
        await ragEngine.ensureIndexed(projectDir)
        return json({ results: ragEngine.search(q, k, projectDir).map(r => ({ source: r.source, score: r.score, preview: r.content.slice(0, 300) })) }, cors)
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { ...cors, status: 400 })
      }
    }
    if (p === "/api/terminal/exec" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const command = body.command as string
      const cwd = resolve((body.cwd as string) ?? process.cwd())
      if (!command?.trim() || command.length > 10_000) return json({ error: "command 为空或过长" }, { ...cors, status: 400 })
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return json({ error: "cwd 不是有效目录" }, { ...cors, status: 400 })
      // 终端与 Agent shell 共用同一命令传输和进程生命周期实现。
      const terminalAbort = new AbortController()
      const sseStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          const emit = (data: unknown) => {
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)) } catch {}
          }
          try {
            const onAbort = () => terminalAbort.abort()
            req.signal.addEventListener("abort", onAbort, { once: true })
            const result = await executeShellCommand(command, {
              cwd,
              timeoutMs: 60_000,
              signal: terminalAbort.signal,
              maxOutputChars: 100_000,
              onLine: (line, type) => emit({ text: line, type }),
            })
            req.signal.removeEventListener("abort", onAbort)
            emit({ text: `\n[进程退出，代码 ${result.exitCode}]`, type: "info" })
          } catch (err: any) {
            emit({ text: `执行失败: ${err.message}`, type: "error" })
          } finally {
            try { controller.close() } catch {}
          }
        },
        cancel() {
          terminalAbort.abort()
        },
      })
      return new Response(sseStream, {
        status: 200,
        headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      })
    }
    // ── 串口 API ──
    if (p === "/api/serial/ports" && req.method === "GET") {
      const r = serialList()
      const ports = (r.data as any)?.ports ?? (r.data as any)?.data?.ports ?? []
      return json({ ports, error: r.error }, cors)
    }
    if (p === "/api/serial/send" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const port = body.port as string
      const baudRate = (body.baudRate as number) ?? 115200
      const data = body.data as string
      if (!port || !data) return json({ error: "缺少 port 或 data" }, { ...cors, status: 400 })
      const r = serialSend(port, baudRate, data)
      return json(r.success ? { success: true, sent: data } : { success: false, error: r.error }, r.success ? cors : { ...cors, status: 502 })
    }
    if (p === "/api/serial/monitor" && req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const port = body.port as string
      const baudRate = (body.baudRate as number) ?? 115200
      const duration = Math.max(1, Math.min((body.duration as number) ?? 300, 3600))
      if (!port) return json({ error: "缺少 port" }, { ...cors, status: 400 })
      const monitorAbort = new AbortController()
      const abortMonitor = () => monitorAbort.abort()
      req.signal.addEventListener("abort", abortMonitor, { once: true })
      const sseStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          const emit = (data: unknown) => {
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)) } catch {}
          }
          try {
            for await (const line of serialMonitor(port, baudRate, duration, monitorAbort.signal)) {
              emit({ text: line, type: "info" })
            }
            emit({ text: "[串口监听已结束]", type: "info" })
          } catch (err: any) {
            emit({ text: `串口错误: ${err.message}`, type: "error" })
          } finally {
            req.signal.removeEventListener("abort", abortMonitor)
            try { controller.close() } catch {}
          }
        },
        cancel() {
          monitorAbort.abort()
        },
      })
      return new Response(sseStream, {
        status: 200,
        headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      })
    }
    // ── 更新检测 ──
    // 未来对接 ADK 包服务器：GET /stable.json → { version, url, notes }
    // 当前前端通过 /api/health 判断后端在线状态

    return new Response("Not Found", { status: 404, headers: cors })
  } catch (err: any) {
    return json({ error: err.message }, { ...cors, status: 500 })
  }
}

function validateModelPayload(configs: unknown): string | null {
  if (!Array.isArray(configs)) return "缺少 models 字段"
  for (const value of configs) {
    const model = value as Partial<ModelConfig>
    if (!model?.name || !model.modelId || !model.provider) {
      return `模型 "${model?.name || "未命名"}" 缺少必填字段 (name/modelId/provider)`
    }
  }
  return normalizeModelConfigs(configs) ? null : "模型配置格式无效"
}

// ══════════════════════════════════════════════
// Chat SSE
