import type { OfficeDailyStats } from "../office/types"
import { topTools } from "../office/office-stats"
import { ActivityIcon, BarChartIcon } from "./Icons"

export function OfficeAnalytics({ stats }: { stats: OfficeDailyStats[] }) {
  const tools = topTools(stats)
  const today = stats[stats.length - 1]
  const max = Math.max(1, ...stats.flatMap((day) => day.hourly))
  const todayToolCount = Object.values(today?.tools ?? {}).reduce((sum, count) => sum + count, 0)
  return (
    <div className="office-analytics">
      <div className="office-analytics-summary">
        <div><ActivityIcon size={13} /><strong>{today?.activities ?? 0}</strong><span>今日动作</span></div>
        <div><BarChartIcon size={13} /><strong>{todayToolCount}</strong><span>工具调用</span></div>
      </div>
      <div className="office-section-title">近 7 天工作热力图</div>
      <div className="office-heatmap">
        {stats.map((day) => (
          <div className="office-heatmap-row" key={day.date}>
            <span>{day.date.slice(5)}</span>
            <div>{day.hourly.map((count, hour) => (
              <i key={hour} title={`${day.date} ${hour}:00 · ${count} 次`} style={{ opacity: count ? .22 + count / max * .78 : .08 }} />
            ))}</div>
          </div>
        ))}
      </div>
      <div className="office-section-title">今日常用工具</div>
      <div className="office-tool-ranking">
        {tools.length ? tools.map(([name, count]) => <div key={name}><span>{name}</span><b>{count}</b></div>) : <small>今天还没有工具调用</small>}
      </div>
    </div>
  )
}
