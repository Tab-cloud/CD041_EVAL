import type { AgentDefinition } from "./types.ts"

/** Agent 定义输入（maxSteps/temperature 可选，有默认值） */
type AgentDefinitionInput = Omit<AgentDefinition, "maxSteps" | "temperature"> & {
  maxSteps?: number
  temperature?: number
}

/**
 * 创建 Agent 定义的辅助函数
 */
export function defineAgent(def: AgentDefinitionInput): AgentDefinition {
  return {
    maxSteps: 0,
    temperature: 0.7,
    ...def,
  } as AgentDefinition
}
