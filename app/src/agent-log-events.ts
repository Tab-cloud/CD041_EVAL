import type { LogLine } from "./store"

export interface PublicAgentLogEvent {
  eventId: string
  seq: number
  type: string
  payload?: Record<string, any>
  createdAt: number
}

export function projectAgentLogEvents(events: PublicAgentLogEvent[]): LogLine[] {
  const explicitErrors = new Set(events
    .filter((event) => event.type === "error" && event.payload?.message)
    .map((event) => String(event.payload!.message)))
  return events.flatMap<LogLine>((event) => {
    const data = event.payload ?? {}
    const base = { id: event.eventId || `event:${event.seq}`, timestamp: event.createdAt }
    switch (event.type) {
      case "task-status": {
        const status = String(data.status ?? "")
        const labels: Record<string, string> = {
          queued: "任务已进入执行队列",
          running: "主 Agent 已开始执行",
          "waiting-approval": "任务正在等待用户确认",
          completed: "任务已完成",
          blocked: data.problem?.message || "任务正在等待外部条件",
          failed: data.problem?.message || "任务执行失败",
          cancelled: "任务已取消",
          interrupted: data.problem?.message || "任务已暂停",
        }
        const text = labels[status]
        if (!text) return []
        if (["blocked", "failed", "interrupted"].includes(status)
          && explicitErrors.has(String(text))) return []
        const type: LogLine["type"] = status === "completed" ? "success"
          : ["blocked", "failed", "cancelled", "interrupted"].includes(status) ? "warning" : "info"
        return [{ ...base, text, type }]
      }
      case "serial-context":
        return [{ ...base, text: `已附加串口上下文：${data.port ?? "unknown"} @ ${data.baudRate ?? "-"}，${data.lineCount ?? 0} 行`, type: "info" as const }]
      case "context-compaction": {
        const status = String(data.status ?? "")
        return [{
          ...base,
          text: String(data.message ?? "上下文容量状态已更新"),
          type: status === "complete" ? "success" as const : status === "start" ? "info" as const : "warning" as const,
        }]
      }
      case "tool-call":
        return [{
          ...base,
          text: `${data.name}${data.target ? ` · ${data.target}` : ""}`,
          type: "tool" as const,
        }]
      case "tool-result":
        return [{
          ...base,
          text: `-> ${data.summary || (data.status === "failed" ? data.problem?.message : "已完成")}`,
          type: data.status === "failed" ? "error" as const : "result" as const,
        }]
      case "model-routed": {
        const position = Number.isFinite(Number(data.segment)) && Number.isFinite(Number(data.step))
          ? ` · 执行段 ${Number(data.segment) + 1}/轮 ${Number(data.step) + 1}` : ""
        const reason = data.failureReason ? ` · 原因：${data.failureReason}`
          : data.fallback && data.reason ? ` · ${data.reason}` : ""
        return [{
          ...base,
          text: `${data.fallback ? "模型回退" : "模型路由"}（对话${position}）：${data.modelName ?? data.modelId}${reason}`,
          type: data.fallback ? "warning" as const : "model" as const,
        }]
      }
      case "model-attempt": {
        const status = String(data.status ?? "")
        const scope = data.scope === "agent" ? "agent" : "tool"
        if (scope === "agent" && status === "reconnecting") {
          return [{
            ...base,
            text: `模型连接中断，正在重新连接 ${Number(data.attempt) || 1}/${Number(data.maxAttempts) || 1}：${data.modelName ?? data.modelId ?? "当前模型"}`,
            type: "warning" as const,
          }]
        }
        const statusLabel = status === "succeeded" ? "成功"
          : status === "skipped" ? "已跳过"
            : status === "cancelled" ? "已取消"
              : status === "running" ? "调用中" : "失败"
        const reason = data.failureReason ? ` · 原因：${data.failureReason}` : ""
        const label = scope === "agent" ? "对话模型" : "工具模型"
        return [{
          ...base,
          text: `${label}（${String(data.operation ?? "工具分析")} · 第 ${Number(data.attempt) || 1} 次）：${data.modelName ?? data.modelId ?? "未知模型"} · ${statusLabel}${reason}`,
          type: status === "succeeded" || status === "running" ? "model" as const : "warning" as const,
        }]
      }
      case "execution-phase":
        return [{ ...base, text: `规划完成，已切换到${executionScopeLabel(String(data.scope ?? "auto-edit"))}`, type: "success" as const }]
      case "error":
        return data.message ? [{ ...base, text: String(data.message), type: "error" as const }] : []
      default:
        return []
    }
  })
}

function executionScopeLabel(scope: string): string {
  if (scope === "full-access") return "完整访问模式"
  if (scope === "confirm-changes") return "变更前确认模式"
  return "自动编辑模式"
}
