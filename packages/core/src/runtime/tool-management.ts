import type { ToolRegistry } from "../tool/registry"
import type { ToolContext, ToolDefinition } from "../tool/types"
import type { ModelRouter } from "../model-router"
import { ToolExecutionRepo } from "../store/tool-execution"
import { getEffectiveSystemSettings } from "./project-settings"

const TESTABLE_PERMISSIONS = new Set(["read", "glob", "grep", "schematic", "websearch", "webfetch", "skill"])

export function buildToolCatalog(registry: ToolRegistry, projectPath?: string) {
  const settings = getEffectiveSystemSettings(projectPath)
  const disabled = new Set(settings.disabledToolIds)
  const stats = new Map(ToolExecutionRepo.stats().map((item) => [item.toolName, item]))
  return registry.list()
    .filter((tool) => !tool.isAvailable || !projectPath || tool.isAvailable({ workingDir: projectPath }))
    .map((tool) => ({
      id: tool.name,
      name: displayName(tool.name),
      description: tool.description,
      permission: tool.permission,
      category: tool.category ?? inferCategory(tool),
      source: tool.source ?? "builtin",
      effects: tool.contract.effects,
      idempotency: tool.contract.idempotency,
      cancellation: tool.contract.cancellation,
      progress: tool.contract.progress,
      parameters: tool.parameters,
      enabled: !disabled.has(tool.name),
      testable: TESTABLE_PERMISSIONS.has(tool.permission),
      projectPath: tool.projectPath,
      stats: stats.get(tool.name) ?? {
        toolName: tool.name, calls: 0, succeeded: 0, failed: 0, averageLatencyMs: 0,
      },
    }))
    .sort((left, right) => left.category.localeCompare(right.category, "zh-CN") || left.name.localeCompare(right.name, "zh-CN"))
}

export async function testManagedTool(
  registry: ToolRegistry,
  input: { toolName: string; params: Record<string, unknown>; projectPath: string },
  modelRouter?: ModelRouter,
) {
  const tool = registry.get(input.toolName)
  if (!tool) throw new Error("工具不存在")
  if (!TESTABLE_PERMISSIONS.has(tool.permission)) throw new Error("该工具可能修改系统、工程或硬件，不能在设置页直接测试")
  if (tool.isAvailable && !tool.isAvailable({ workingDir: input.projectPath })) throw new Error("工具不适用于当前项目")
  const settings = getEffectiveSystemSettings(input.projectPath)
  if (settings.disabledToolIds.includes(tool.name)) throw new Error("工具当前已停用")
  const context: ToolContext = {
    sessionId: "settings-tool-test",
    agentId: "system",
    workingDir: input.projectPath,
    modelRouter,
    searchConfig: {
      provider: settings.searchProvider,
      timeoutMs: settings.searchTimeoutMs,
      maxResults: settings.searchMaxResults,
    },
    disabledSkillIds: settings.disabledSkillIds,
  }
  return registry.execute(tool.name, input.params, context)
}

function inferCategory(tool: ToolDefinition): string {
  if (tool.source === "mcp") return "MCP"
  if (tool.contract.effects.includes("hardware")) return "硬件"
  if (tool.contract.effects.includes("network")) return "网络"
  if (["read", "write", "edit", "glob", "grep"].includes(tool.permission)) return "文件"
  if (["bash", "compile"].includes(tool.permission)) return "终端与构建"
  if (["schematic", "datasheet"].includes(tool.permission)) return "原理图与数据手册"
  return "Agent 协作"
}

function displayName(id: string): string {
  return id.replace(/^mcp__[^_]+__/, "").replaceAll("_", " ")
}
