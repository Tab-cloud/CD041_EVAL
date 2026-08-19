import type { AgentRegistry } from "../agent/registry.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import { configStore } from "./config-store.ts"
import { llmManager, summarizeModelFailure } from "./llm-manager.ts"
import { taskScheduler } from "./task-scheduler.ts"
import { getSystemSettings } from "./system-settings.ts"
import { listProjectSettings } from "./project-settings.ts"
import { SessionRepo, ProjectRepo } from "../store/repository.ts"
import { ToolExecutionRepo } from "../store/tool-execution.ts"
import { TaskRunRepo } from "../store/task-run.ts"
import { OrchestrationLogRepo } from "../store/orchestration-log.ts"
import { ModelAttemptRepo } from "../store/model-attempt.ts"

export function buildDiagnosticsSnapshot(
  redacted: boolean,
  dependencies: {
    toolRegistry: ToolRegistry | null
    agentRegistry: AgentRegistry | null
  },
) {
  const settings = getSystemSettings()
  const calls = llmManager.getCallLogs({ limit: 30 }).map((call) => redacted
    ? { ...call, prompt: "[已省略]", response: "[已省略]", sessionId: "[已省略]" }
    : call)
  const tools = ToolExecutionRepo.listRecent(30).map((execution) => redacted
    ? { ...execution, input: {}, filePath: execution.filePath ? "[工作区文件]" : undefined }
    : execution)
  const tasks = TaskRunRepo.listRecent(20).map((task) => redacted
    ? { ...task, message: "[已省略]", workingDir: "[已省略]", result: task.result ? "[已省略]" : undefined }
    : task)
  const orchestration = OrchestrationLogRepo.list({ limit: 100 }).map((event) => redacted
    ? { ...event, sessionId: "[已省略]", data: {} }
    : event)
  const modelAttempts = ModelAttemptRepo.listRecent(100).map((attempt) => redacted
    ? {
        ...attempt,
        sessionId: "[已省略]",
        error: summarizeModelFailure(attempt.error),
      }
    : attempt)
  const models = configStore.load().map(({ apiKey: _apiKey, ...model }) => ({
    ...model,
    apiKeyConfigured: Boolean(_apiKey),
  }))
  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      version: process.version,
      bunVersion: typeof Bun !== "undefined" ? Bun.version : undefined,
      uptimeSeconds: Math.round(process.uptime()),
    },
    health: {
      status: "ok",
      tools: dependencies.toolRegistry?.list().length ?? 0,
      agents: dependencies.agentRegistry?.list().length ?? 0,
      models: models.filter((model) => model.enabled).length,
      scheduler: taskScheduler.getStats(),
    },
    counts: {
      sessions: SessionRepo.list().length,
      projects: ProjectRepo.list().length,
      projectOverrides: listProjectSettings().length,
      modelCalls: llmManager.getCallLogs({ limit: 1_000 }).length,
      modelAttempts: modelAttempts.length,
      toolExecutions: ToolExecutionRepo.count(),
      tasks: TaskRunRepo.count(),
      orchestrationEvents: orchestration.length,
    },
    usage: llmManager.getUsageStats(),
    errorRate: llmManager.getErrorRate(),
    settings: redacted
      ? { ...settings, defaultWorkspace: settings.defaultWorkspace ? "[已省略]" : "" }
      : settings,
    models,
    calls,
    modelAttempts,
    tools,
    tasks,
    orchestration,
  }
}
