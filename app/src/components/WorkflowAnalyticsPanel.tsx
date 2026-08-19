import { useCallback, useEffect, useState } from "react"
import { apiFetch } from "../api"
import { AlertCircleIcon, CheckCircleIcon, ClockIcon, RefreshCwIcon, SpinnerIcon } from "./Icons"
import type { WorkflowAnalytics } from "./workflow-types"
import { WorkflowWebhookPanel } from "./WorkflowWebhookPanel"

export function WorkflowAnalyticsPanel({ sessionId }: { sessionId: string }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<WorkflowAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiFetch(`/api/workflows/analytics?sessionId=${encodeURIComponent(sessionId)}&days=${days}`)
      const payload = await response.json().catch(() => ({})) as { analytics?: WorkflowAnalytics; error?: string }
      if (!response.ok || !payload.analytics) throw new Error(payload.error || "统计数据加载失败")
      setData(payload.analytics); setError("")
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }, [days, sessionId])

  useEffect(() => { void refresh() }, [refresh])
  const maxDaily = Math.max(1, ...(data?.daily.map((point) => point.total) ?? [1]))
  return (
    <div className="workflow-analytics">
      <div className="schedule-toolbar">
        <div className="analytics-period">{[7, 30, 90].map((value) => <button key={value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>{value}天</button>)}</div>
        <button className="icon-action-btn" title="刷新统计" onClick={() => void refresh()}><RefreshCwIcon size={12} /></button>
      </div>
      {error && <div className="tasks-error"><AlertCircleIcon size={12} />{error}</div>}
      {loading && !data ? <div className="right-empty compact"><SpinnerIcon size={14} className="spin" /></div> : data && <>
        <div className="analytics-metrics">
          <Metric label="运行" value={String(data.total)} />
          <Metric label="成功率" value={formatPercent(data.successRate)} tone="success" />
          <Metric label="平均耗时" value={formatDuration(data.averageDurationMs)} />
          <Metric label="节点完成" value={formatPercent(data.nodeCompletionRate)} />
        </div>
        <div className="analytics-summary">
          <span><CheckCircleIcon size={11} />完成 {data.completed}</span>
          <span><AlertCircleIcon size={11} />失败 {data.failed}</span>
          <span><ClockIcon size={11} />进行中 {data.active}</span>
        </div>
        <div className="analytics-trend" aria-label="每日工作流运行趋势">
          {data.daily.map((point) => <div className="analytics-day" key={point.date} title={`${point.date} · ${point.total} 次`}>
            <span style={{ height: `${Math.max(point.total ? 12 : 2, point.total / maxDaily * 100)}%` }} />
          </div>)}
        </div>
      </>}
      <WorkflowWebhookPanel />
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className={`analytics-metric ${tone ?? ""}`}><strong>{value}</strong><span>{label}</span></div>
}
function formatPercent(value: number): string { return `${Math.round(value * 100)}%` }
function formatDuration(ms: number): string {
  if (ms <= 0) return "--"
  if (ms < 60_000) return `${Math.round(ms / 1_000)}秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}分`
  return `${(ms / 3_600_000).toFixed(1)}时`
}
