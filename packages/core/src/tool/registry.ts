import type { ToolDefinition, ToolContext, ToolResult } from "./types.ts"
import { invalidToolInputResult, normalizeToolResult } from "./outcome.ts"
import { projectToolResultArtifact } from "../runtime/session-artifact-projection.ts"

/**
 * 工具注册表
 *
 * 管理所有工具的注册、查找、权限过滤、执行调度。
 * 支持：
 * - 内置工具（随 Agent 引擎启动注册）
 * - 插件工具（运行时动态注册）
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()
  private localTools: Map<string, Array<{ token: object; tool: ToolDefinition }>> = new Map()
  /** All workspace mutations share one commit lane per workspace. */
  private mutationTails = new Map<string, Promise<void>>()

  /**
   * 注册内置工具
   */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已存在`)
    }
    this.tools.set(tool.name, tool)
  }

  /**
   * 批量注册内置工具
   */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /**
   * 运行时注册局部工具（如插件提供的工具）
   * 返回一个 token，用于后续注销
   */
  registerLocal(tool: ToolDefinition): { dispose: () => void } {
    const token = {}
    const entry = this.localTools.get(tool.name) ?? []
    entry.push({ token, tool })
    this.localTools.set(tool.name, entry)

    return {
      dispose: () => {
        const entries = this.localTools.get(tool.name) ?? []
        this.localTools.set(
          tool.name,
          entries.filter((e) => e.token !== token),
        )
      },
    }
  }

  /**
   * 获取工具定义
   */
  get(name: string): ToolDefinition | undefined {
    // 局部工具覆盖内置工具
    const localEntries = this.localTools.get(name)
    if (localEntries && localEntries.length > 0) {
      return localEntries[localEntries.length - 1].tool
    }
    return this.tools.get(name)
  }

  /**
   * 列出所有工具
   */
  list(): ToolDefinition[] {
    const all = new Map<string, ToolDefinition>()

    // 先加载内置工具
    for (const [name, tool] of this.tools) {
      all.set(name, tool)
    }

    // 局部工具覆盖
    for (const [name, entries] of this.localTools) {
      if (entries.length > 0) {
        all.set(name, entries[entries.length - 1].tool)
      }
    }

    return Array.from(all.values())
  }

  /**
   * 按权限过滤工具列表
   * @param allowedPermissions 允许的权限列表
   */
  listByPermissions(allowedPermissions: string[]): ToolDefinition[] {
    return this.list().filter((tool) => allowedPermissions.includes(tool.permission))
  }

  /**
   * 执行工具
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.get(name)
    if (!tool) {
      return normalizeToolResult(name, { success: false, error: `未知工具: ${name}` })
    }

    const validationError = validateValue(params, tool.parameters, "params")
    if (validationError) return invalidToolInputResult(name, validationError)
    if (ctx.abortSignal?.aborted) return normalizeToolResult(name, { success: false, error: "工具执行已取消" })

    const executeAuthorized = async (): Promise<ToolResult> => {
      const evidenceDecision = ctx.evidence?.authorize(name, params)
      if (evidenceDecision && !evidenceDecision.allowed) {
        const summary = evidenceDecision.summary ?? "缺少执行所需证据"
        return normalizeToolResult(name, {
          success: false,
          error: summary,
          data: { requirements: evidenceDecision.requirements ?? [] },
          outcome: {
            status: "failed",
            category: "evidence",
            summary,
            fingerprint: `evidence:${name}:${summary}`,
            diagnostic: {
              kind: evidenceDecision.kind ?? "evidence-required",
              evidence: [],
              nextActions: evidenceDecision.requirements ?? [],
            },
          },
        })
      }

      try {
        const result = normalizeToolResult(name, await tool.execute(params, ctx))
        ctx.evidence?.record(name, params, result)
        const artifact = projectToolResultArtifact(name, params, result, ctx)
        if (artifact) ctx.onAgentEvent?.({ type: "artifact-updated", revision: artifact.revision, artifact })
        return result
      } catch (err) {
        return normalizeToolResult(name, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (tool.contract.effects.includes("workspace-write")) {
      return this.withMutationLock(ctx.workingDir, executeAuthorized)
    }
    return executeAuthorized()
  }

  /**
   * 生成 LLM 可见的工具 Schema 列表
   */
  toLLMSchema(): Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }> {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  /**
   * 检查是否有指定工具
   */
  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  private async withMutationLock<T>(workingDir: string, action: () => Promise<T>): Promise<T> {
    const key = workingDir.replace(/\\/g, "/").toLowerCase()
    const previous = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.mutationTails.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key)
    }
  }
}

function validateValue(value: unknown, schemaValue: unknown, path: string): string | null {
  if (!schemaValue || typeof schemaValue !== "object") return null
  const schema = schemaValue as Record<string, any>
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} 必须是 ${schema.enum.join(" / ")}`
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} 必须是 object`
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined || record[key] === null) return `${path}.${key} 为必填项`
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (record[key] === undefined) continue
      const error = validateValue(record[key], child, `${path}.${key}`)
      if (error) return error
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      const extra = Object.keys(record).find((key) => !allowed.has(key))
      if (extra) return `${path}.${extra} 不是允许的参数`
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} 必须是 array`
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} 至少 ${schema.minItems} 项`
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} 最多 ${schema.maxItems} 项`
    for (let i = 0; i < value.length; i++) {
      const error = validateValue(value[i], schema.items, `${path}[${i}]`)
      if (error) return error
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return `${path} 必须是 string`
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} 长度不能小于 ${schema.minLength}`
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} 长度不能超过 ${schema.maxLength}`
    if (typeof schema.pattern === "string") {
      try { if (!new RegExp(schema.pattern).test(value)) return `${path} 格式无效` } catch { return `${path} 的 schema.pattern 无效` }
    }
  } else if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    return `${path} 必须是有限 number`
  } else if (schema.type === "integer" && (!Number.isInteger(value))) {
    return `${path} 必须是 integer`
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    return `${path} 必须是 boolean`
  }
  if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} 不能小于 ${schema.minimum}`
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} 不能大于 ${schema.maximum}`
  }
  return null
}
