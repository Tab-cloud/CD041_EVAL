import type { ModelCapability } from "../model-router/types.ts"

/** Agent 运行模式（同时决定可见性：primary 可见，subagent/hidden 不可见） */
export type AgentMode = "primary" | "subagent" | "hidden"

/**
 * Agent 权限规则
 *
 * AgentDefinition.tools 是第一层白名单；精确的 deny/ask 规则作为第二层运行时门控。
 */
export interface AgentPermission {
  /** 权限动作名 (如 "read", "edit", "compile", "flash", "serial" 等) */
  permission: string
  /** 资源匹配模式 (如 "*" 或 "src/*.c") */
  pattern: string
  /** 效果: allow / deny / ask */
  effect: "allow" | "deny" | "ask"
}

/** Agent 定义 */
export interface AgentDefinition {
  /** 唯一标识 (如 "firmware-dev") */
  id: string
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string
  /** 运行模式：primary=稳定主 Agent；subagent/hidden=仅供主 Agent 委派或内部协议使用 */
  mode: AgentMode
  /** 所需模型能力标签 */
  requiredCapabilities: ModelCapability[]
  /** 绑定的工具列表 (工具名称) —— 真正的权限门控由它实现 */
  tools: string[]
  /** 权限规则（运行时会强制精确的 deny/ask 规则） */
  permissions: AgentPermission[]
  /** 系统提示词 */
  systemPrompt: string
  /** 最大步数限制 (0 = 不限制) */
  maxSteps: number
  /** 温度参数 (0-2) */
  temperature?: number
  /** 颜色标记 (用于 UI 区分) */
  color?: string
  /** Agent 来源，供管理中心区分。 */
  source?: "builtin" | "custom"
  /** 项目级自定义 Agent 的工作空间限制。 */
  projectPath?: string
}
