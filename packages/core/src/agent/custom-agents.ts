import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { ModelCapability } from "../model-router/types"
import { ConfigRepo } from "../store/repository"
import type { ToolRegistry } from "../tool/registry"
import type { AgentRegistry } from "./registry"
import type { AgentDefinition, AgentMode } from "./types"

const KEY = "custom.agents"
const CAPABILITIES = new Set<ModelCapability>(["vision", "reasoning", "coding", "search", "chat"])

export interface CustomAgentInput {
  id?: string
  name: string
  description: string
  mode: AgentMode
  requiredCapabilities: ModelCapability[]
  tools: string[]
  systemPrompt: string
  maxSteps: number
  temperature: number
  color: string
  projectPath?: string
}

export function loadCustomAgents(toolRegistry: ToolRegistry): AgentDefinition[] {
  try {
    const raw = JSON.parse(ConfigRepo.get(KEY) ?? "[]")
    return normalizeCustomAgents(raw, toolRegistry)
  } catch {
    return []
  }
}

export function saveCustomAgents(value: unknown, toolRegistry: ToolRegistry): AgentDefinition[] {
  const agents = normalizeCustomAgents(value, toolRegistry)
  ConfigRepo.set(KEY, JSON.stringify(agents.map(toStored)))
  return agents
}

export function applyCustomAgents(agentRegistry: AgentRegistry, toolRegistry: ToolRegistry, agents = loadCustomAgents(toolRegistry)): void {
  for (const agent of agentRegistry.list().filter((item) => item.source === "custom")) agentRegistry.unregister(agent.id)
  for (const agent of agents) {
    if (!agentRegistry.get(agent.id)) agentRegistry.register(agent)
  }
}

export function normalizeCustomAgents(value: unknown, toolRegistry: ToolRegistry): AgentDefinition[] {
  if (!Array.isArray(value)) throw new Error("agents 必须是数组")
  const ids = new Set<string>()
  return value.slice(0, 50).map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`第 ${index + 1} 个 Agent 配置无效`)
    const input = raw as Partial<CustomAgentInput>
    const id = typeof input.id === "string" && /^custom-[A-Za-z0-9_-]{1,80}$/.test(input.id)
      ? input.id : `custom-${randomUUID()}`
    if (ids.has(id)) throw new Error(`Agent ID 重复: ${id}`)
    ids.add(id)
    const name = text(input.name, 80)
    const description = text(input.description, 300)
    const systemPrompt = text(input.systemPrompt, 30_000)
    if (!name || !description || !systemPrompt) throw new Error(`Agent ${id} 缺少名称、描述或系统提示词`)
    // Custom definitions are professional workers. The built-in main-agent is
    // the only primary owner and cannot be replaced by configuration.
    const mode: AgentMode = "subagent"
    const requiredCapabilities = Array.isArray(input.requiredCapabilities)
      ? [...new Set(input.requiredCapabilities.filter((item): item is ModelCapability => CAPABILITIES.has(item)))].slice(0, 5)
      : []
    if (requiredCapabilities.length === 0) requiredCapabilities.push("chat")
    const tools = Array.isArray(input.tools)
      ? [...new Set(input.tools.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(item)))].slice(0, 100)
      : []
    const permissions = tools.map((toolName) => ({
      permission: toolRegistry.get(toolName)?.permission ?? toolName,
      pattern: "*",
      effect: "allow" as const,
    }))
    return {
      id, name, description, mode, requiredCapabilities, tools,
      permissions: [...permissions, { permission: "*", pattern: "*", effect: "deny" as const }],
      systemPrompt,
      maxSteps: clamp(input.maxSteps, 0, 50, 15),
      temperature: clamp(input.temperature, 0, 2, 0.7),
      color: /^#[0-9a-f]{6}$/i.test(input.color ?? "") ? input.color : "#0ea5e9",
      source: "custom",
      projectPath: typeof input.projectPath === "string" && input.projectPath.trim() ? resolve(input.projectPath) : undefined,
    }
  })
}

function toStored(agent: AgentDefinition): CustomAgentInput {
  return {
    id: agent.id, name: agent.name, description: agent.description, mode: agent.mode,
    requiredCapabilities: agent.requiredCapabilities, tools: agent.tools,
    systemPrompt: agent.systemPrompt, maxSteps: agent.maxSteps,
    temperature: agent.temperature ?? 0.7, color: agent.color ?? "#0ea5e9",
    projectPath: agent.projectPath,
  }
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}
