/**
 * @eval-agent/core
 *
 * Eval 核心引擎 — 完整导出
 */

// ─── 模型路由 ───
export { ModelRouter } from "./model-router/index.ts"
export type { ModelCapability, ModelConfig, RoutingDecision } from "./model-router/types.ts"

// ─── Agent 系统 ───
export { AgentRegistry } from "./agent/registry.ts"
export { defineAgent } from "./agent/define.ts"
export type { AgentDefinition, AgentMode, AgentPermission } from "./agent/types.ts"

// ─── 工具系统 ───
export { ToolRegistry } from "./tool/registry.ts"
export { defineTool } from "./tool/define.ts"
export type { ToolDefinition, ToolContext, ToolResult } from "./tool/types.ts"

// ─── 嵌入式工具 ───
export {
  schematicReadTool,
  pinExtractTool,
  compileTool,
  flashTool,
  serialOpenTool,
  serialMonitorTool,
  swdDebugTool,
  usbTool,
  projectInitTool,
  lvglGenTool,
  delegateDagTool,
  EMBEDDED_TOOLS,
} from "./tool/tools-index.ts"

// ─── 项目管理 ───
export { ProjectManager } from "./project/manager.ts"
export type { ProjectConfig, ProjectTemplate } from "./project/types.ts"

// ─── 知识库 ───
export { findChip, listChipsByFamily, CHIP_DATABASE } from "./knowledge/chips.ts"
export type { ChipInfo } from "./knowledge/chips.ts"
