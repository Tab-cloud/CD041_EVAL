/**
 * ContextUsagePanel — 上下文容量监控面板
 * 显示 token 用量、分类占比、进度条
 */
import { GaugeIcon } from "./Icons"
import type { ContextUsageSnapshot } from "../context-state"

interface ContextUsagePanelProps {
  snapshot: ContextUsageSnapshot
}

function formatWan(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : `${n}`
}

const BREAKDOWN_ITEMS: Array<{ key: string; label: string; color: string }> = [
  { key: "messages", label: "消息", color: "var(--info)" },
  { key: "systemTools", label: "系统工具", color: "var(--accent)" },
  { key: "skills", label: "技能", color: "#8b5cf6" },
  { key: "systemPrompt", label: "系统提示词", color: "var(--warning)" },
  { key: "other", label: "其他", color: "var(--text-tertiary)" },
]

export function ContextUsagePanel({ snapshot }: ContextUsagePanelProps) {
  const { used, total, breakdown } = snapshot
  const pct = total > 0 ? ((used / total) * 100).toFixed(1) : "0"
  const barColor = Number(pct) > 80 ? "var(--error)" : Number(pct) > 50 ? "var(--warning)" : "var(--info)"

  return (
    <div className="ctx-usage-panel">
      <div className="ctx-usage-header">
        <GaugeIcon size={12} />
        <span className="ctx-usage-title">可用输入上下文</span>
        {snapshot.estimated && <span className="ctx-usage-badge">估算</span>}
        <span className="ctx-usage-value">{formatWan(used)}/{formatWan(total)} ({pct}%)</span>
      </div>
      <div className="ctx-usage-bar">
        <div className="ctx-usage-bar-fill" style={{ width: `${Math.min(Number(pct), 100)}%`, background: barColor }} />
      </div>
      {snapshot.protocolMessages && <div className="ctx-usage-protocol">
        <span>对话结构</span>
        <strong>{snapshot.protocolMessages.used}/{snapshot.protocolMessages.total}</strong>
        <small>超过 80% 自动压缩</small>
      </div>}
      <div className="ctx-usage-breakdown">
        {BREAKDOWN_ITEMS.map(item => {
          const val = breakdown[item.key as keyof typeof breakdown] ?? 0
          const subPct = used > 0 ? ((val / used) * 100).toFixed(1) : "0"
          if (Number(subPct) <= 0) return null
          return (
            <div key={item.key} className="ctx-usage-row">
              <span className="ctx-usage-dot" style={{ background: item.color }} />
              <span className="ctx-usage-label">{item.label}</span>
              <span className="ctx-usage-pct">{subPct}%</span>
            </div>
          )
        })}
      </div>
      <div className="ctx-usage-footnote">
        <span>{snapshot.source === "compaction-estimate"
          ? "摘要已生效，精确值将在下次模型请求后更新"
          : snapshot.source === "preflight-estimate"
            ? "本轮请求投影估算"
            : "最近一次模型请求"}</span>
        {snapshot.updatedAt && <time>{new Date(snapshot.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>}
      </div>
    </div>
  )
}
