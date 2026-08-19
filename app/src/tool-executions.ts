import type { WorkLogEntry } from "./store"
import { apiFetch } from "./api"

export const TOOL_EXECUTION_UNDONE_EVENT = "eval:tool-execution-undone"

export interface ToolExecutionDto {
  kind: "tool-execution"
  id: string
  toolName: string
  status: "running" | "succeeded" | "failed" | "denied"
  filePath?: string
  diff?: string
  linesAdded: number
  linesRemoved: number
  reversible: boolean
  problem?: {
    kind: "problem"
    code: string
    message: string
    diagnosticId: string
    retryable: boolean
  }
  startedAt: number
  finishedAt?: number
  undoneAt?: number
}

const LABELS: Record<string, string> = {
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  move: "移动文件",
  glob: "搜索文件",
  grep: "搜索内容",
  websearch: "搜索网络",
  webfetch: "读取网页",
  bash: "执行命令",
  compile: "编译项目",
  flash: "烧录固件",
}

export function executionToWorkLog(execution: ToolExecutionDto): WorkLogEntry {
  const target = execution.filePath || ""
  const normalized = target.replace(/\\/g, "/")
  const separator = normalized.lastIndexOf("/")
  const type: WorkLogEntry["type"] = ["write", "edit", "move"].includes(execution.toolName)
    ? "edit"
    : ["bash", "compile", "flash"].includes(execution.toolName) ? "execute" : "search"
  const status = execution.status === "succeeded" ? "done"
    : execution.status === "running" ? "running" : "error"

  return {
    id: `log-${execution.id}`,
    executionId: execution.id,
    type,
    label: LABELS[execution.toolName] ?? execution.toolName,
    fileName: separator >= 0 ? normalized.slice(separator + 1) : normalized || undefined,
    filePath: separator >= 0 ? normalized.slice(0, separator) : undefined,
    linesChanged: execution.linesAdded || execution.linesRemoved
      ? { added: execution.linesAdded, removed: execution.linesRemoved }
      : undefined,
    diff: execution.diff,
    error: execution.problem?.message,
    reversible: execution.reversible,
    undoneAt: execution.undoneAt,
    timestamp: execution.startedAt,
    status,
  }
}

export async function undoToolExecution(executionId: string): Promise<ToolExecutionDto> {
  const response = await apiFetch("/api/tool-executions/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: executionId }),
  })
  const payload = await response.json().catch(() => ({})) as { execution?: ToolExecutionDto; error?: string }
  if (!response.ok || !payload.execution) throw new Error(payload.error || `撤销失败: HTTP ${response.status}`)
  window.dispatchEvent(new CustomEvent(TOOL_EXECUTION_UNDONE_EVENT, { detail: { executionId } }))
  return payload.execution
}
