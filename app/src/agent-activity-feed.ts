import type { WorkLogEntry } from "./store"

export interface ActivityHeadline {
  text: string
  tone: "active" | "complete" | "error" | "reconnecting"
}

export interface ActivityWindow {
  visible: WorkLogEntry[]
  hidden: WorkLogEntry[]
}

export function buildActivityHeadline(input: {
  entries: WorkLogEntry[]
  isStreaming: boolean
  activeLabel?: string
  connectionStatus?: "connected" | "disconnected" | "connecting"
  reconnectAttempt?: number
}): ActivityHeadline {
  if (input.connectionStatus === "connecting" && (input.reconnectAttempt ?? 0) > 0) {
    return {
      text: input.reconnectAttempt
        ? `正在重新连接 · 第 ${input.reconnectAttempt} 次`
        : "正在重新连接",
      tone: "reconnecting",
    }
  }

  if (input.isStreaming) {
    return {
      text: input.activeLabel?.trim() || "正在处理任务",
      tone: "active",
    }
  }

  const presentable = input.entries.filter((entry) => !entry.recovered)
  const errors = presentable.filter((entry) => entry.status === "error").length
  const completed = presentable.filter((entry) => entry.status === "done")
  if (errors > 0) {
    return {
      text: `${completed.length ? `完成 ${completed.length} 项 · ` : ""}${errors} 项需要处理`,
      tone: "error",
    }
  }

  const edits = completed.filter((entry) => entry.type === "edit")
  const commands = completed.filter((entry) => entry.type === "execute")
  const lookups = completed.filter((entry) => entry.type === "search")
  const parts: string[] = []
  if (edits.length) {
    const fileCount = new Set(edits.map((entry) => entry.fileName || entry.filePath || entry.id)).size
    parts.push(`编辑了 ${fileCount} 个文件`)
  }
  if (commands.length) parts.push(`运行了 ${commands.length} 个命令`)
  if (lookups.length) parts.push(`查阅了 ${lookups.length} 项资料`)
  return {
    text: parts.join(" · ") || (completed.length ? `完成了 ${completed.length} 项操作` : "准备执行"),
    tone: "complete",
  }
}

export function activityWindow(entries: WorkLogEntry[], limit = 8): ActivityWindow {
  const ordered = entries
    .filter((entry) => !entry.recovered)
    .sort((left, right) => left.timestamp - right.timestamp)
  if (ordered.length <= limit) return { visible: ordered, hidden: [] }
  return {
    visible: ordered.slice(-limit),
    hidden: ordered.slice(0, -limit),
  }
}

export function activityEntryLabel(entry: WorkLogEntry): string {
  const action = entry.type === "edit"
    ? "编辑"
    : entry.type === "execute"
      ? commandAction(entry.label)
      : lookupAction(entry.label)

  if (entry.status === "running") return `正在${action}`
  if (entry.status === "error") return `${action}失败`
  return `已${action}`
}

function lookupAction(label: string): string {
  if (/读取|read/i.test(label)) return "读取"
  if (/搜索|查找|glob|grep|search/i.test(label)) return "搜索"
  return label || "检查"
}

function commandAction(label: string): string {
  if (/编译|compile|build/i.test(label)) return "编译"
  if (/烧录|flash/i.test(label)) return "烧录"
  return "运行命令"
}
