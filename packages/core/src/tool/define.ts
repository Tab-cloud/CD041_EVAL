import type { ToolDefinition, ToolContext, ToolResult } from "./types.ts"

/**
 * 创建工具定义的辅助函数
 */
export function defineTool(def: Omit<ToolDefinition, "execute"> & {
  // execute 的 params 放宽为 any：各工具用解构签名（如 { paths }/{ path, content }）
  // 声明自己的参数结构，Record<string,unknown> 的参数逆变会与之冲突；
  // 实际参数结构由各工具的 JSON Schema 在运行时约束，类型上不强求统一。
  execute: (params: any, ctx: ToolContext) => Promise<ToolResult>
}): ToolDefinition {
  return def as ToolDefinition
}
