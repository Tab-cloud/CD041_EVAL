import type { AgentDefinition } from "./types.ts"

/**
 * Agent 注册表
 * 
 * 管理所有嵌入式领域 Agent 的注册、查找、默认选择。
 */
export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map()
  private defaultAgentId: string | null = null

  /**
   * 注册一个 Agent
   */
  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" 已存在`)
    }
    if (agent.mode === "primary" && this.defaultAgentId && this.defaultAgentId !== agent.id) {
      throw new Error(`主 Agent 已固定为 "${this.defaultAgentId}"，不能再注册第二个 primary Agent`)
    }
    this.agents.set(agent.id, agent)

    if (agent.mode === "primary") {
      this.defaultAgentId = agent.id
    }
  }

  /**
   * 批量注册
   */
  registerAll(agents: AgentDefinition[]): void {
    for (const agent of agents) {
      this.register(agent)
    }
  }

  /**
   * 注销 Agent
   */
  unregister(id: string): void {
    if (this.defaultAgentId === id) {
      throw new Error(`主 Agent "${id}" 是运行时责任主体，不能注销`)
    }
    this.agents.delete(id)
  }

  /**
   * 获取 Agent
   */
  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id)
  }

  /**
   * 获取默认 Agent
   */
  getDefault(): AgentDefinition | undefined {
    if (this.defaultAgentId) {
      return this.agents.get(this.defaultAgentId)
    }
    return undefined
  }

  /**
   * 设置默认 Agent
   */
  setDefault(id: string): void {
    const agent = this.agents.get(id)
    if (!agent) {
      throw new Error(`Agent "${id}" 不存在`)
    }
    if (agent.mode !== "primary") throw new Error(`专业 Agent "${id}" 不能成为根 owner`)
    if (this.defaultAgentId && this.defaultAgentId !== id) {
      throw new Error(`主 Agent 已固定为 "${this.defaultAgentId}"`)
    }
    this.defaultAgentId = id
  }

  /**
   * 列出所有 Agent
   */
  list(filter?: { mode?: AgentDefinition["mode"] }): AgentDefinition[] {
    let result = Array.from(this.agents.values())

    if (filter?.mode) {
      result = result.filter((a) => a.mode === filter.mode)
    }

    return result
  }

  /**
   * 列出用户可见的 primary Agent
   */
  listVisible(): AgentDefinition[] {
    return this.list({ mode: "primary" })
  }

  /**
   * 获取 Agent 需要的工具列表（去重并集）
   */
  getRequiredTools(agentId: string): string[] {
    const agent = this.agents.get(agentId)
    if (!agent) return []
    return [...new Set(agent.tools)]
  }
}
