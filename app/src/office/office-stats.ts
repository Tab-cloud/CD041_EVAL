import type { OfficeActivity, OfficeDailyStats } from "./types"

const STORAGE_KEY = "eval_digital_office_stats_v1"
const MAX_DAYS = 14

export function recordOfficeActivity(activity: OfficeActivity): void {
  const all = loadAll()
  const date = dateKey(activity.timestamp)
  const current = all[date] ?? emptyDay(date)
  const hour = new Date(activity.timestamp).getHours()
  current.hourly[hour] = (current.hourly[hour] ?? 0) + 1
  current.activities += 1
  if (activity.toolName) current.tools[activity.toolName] = (current.tools[activity.toolName] ?? 0) + 1
  if (activity.state === "failed") current.failures += 1
  all[date] = current
  const trimmed = Object.fromEntries(Object.entries(all).sort(([a], [b]) => b.localeCompare(a)).slice(0, MAX_DAYS))
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed)) } catch { /* 统计失败不影响任务 */ }
}

export function getOfficeStats(days = 7): OfficeDailyStats[] {
  const all = loadAll()
  const result: OfficeDailyStats[] = []
  const cursor = new Date()
  for (let index = 0; index < days; index++) {
    const key = dateKey(cursor.getTime())
    result.unshift(all[key] ?? emptyDay(key))
    cursor.setDate(cursor.getDate() - 1)
  }
  return result
}

export function topTools(stats: OfficeDailyStats[], limit = 5): Array<[string, number]> {
  const totals: Record<string, number> = {}
  for (const day of stats) for (const [name, count] of Object.entries(day.tools)) totals[name] = (totals[name] ?? 0) + count
  return Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, limit)
}

function loadAll(): Record<string, OfficeDailyStats> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
    return value && typeof value === "object" ? value : {}
  } catch { return {} }
}

function emptyDay(date: string): OfficeDailyStats {
  return { date, hourly: Array.from({ length: 24 }, () => 0), tools: {}, activities: 0, failures: 0 }
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
