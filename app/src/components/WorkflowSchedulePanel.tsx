import { useCallback, useEffect, useState } from "react"
import { apiFetch } from "../api"
import { AlertCircleIcon, ClockIcon, PlayIcon, PlusIcon, SpinnerIcon, Trash2Icon } from "./Icons"
import type { WorkflowSchedule, WorkflowTemplate } from "./workflow-types"

interface Props { sessionId: string; workspace: string; templates: WorkflowTemplate[] }

export function WorkflowSchedulePanel({ sessionId, workspace, templates }: Props) {
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")
  const [templateId, setTemplateId] = useState("quick-prototype")
  const [frequency, setFrequency] = useState<"once" | "interval">("once")
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [nextRun, setNextRun] = useState(defaultDateTime())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/workflow-schedules?sessionId=${encodeURIComponent(sessionId)}`)
      const payload = await response.json().catch(() => ({})) as { schedules?: WorkflowSchedule[]; error?: string }
      if (!response.ok) throw new Error(payload.error || "定时计划加载失败")
      setSchedules(payload.schedules ?? []); setError("")
    } catch (reason) { setError(messageOf(reason)) }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  const create = async () => {
    setBusy("create")
    try {
      const response = await apiFetch("/api/workflow-schedules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, sessionId, templateId, goal, workingDir: workspace, frequency, intervalMinutes, nextRunAt: new Date(nextRun).getTime() }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "定时计划创建失败")
      setName(""); setGoal(""); setShowCreate(false); setNextRun(defaultDateTime())
      await refresh()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const update = async (id: string, fields: Record<string, unknown>) => {
    setBusy(id)
    try {
      const response = await apiFetch("/api/workflow-schedules", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...fields }) })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "计划更新失败")
      await refresh()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const runNow = async (id: string) => {
    setBusy(id)
    try {
      const response = await apiFetch("/api/workflow-schedules/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "立即运行失败")
      await refresh()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const remove = async (id: string) => {
    setBusy(id)
    try {
      const response = await apiFetch(`/api/workflow-schedules?id=${encodeURIComponent(id)}`, { method: "DELETE" })
      if (!response.ok) throw new Error("计划删除失败")
      await refresh()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  return (
    <div className="workflow-schedules">
      <div className="schedule-toolbar"><span>计划</span><button className="icon-action-btn" title="新建计划" onClick={() => setShowCreate((value) => !value)}><PlusIcon size={13} /></button></div>
      {error && <div className="tasks-error"><AlertCircleIcon size={12} />{error}</div>}
      {showCreate && <div className="workflow-create-form schedule-form">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="计划名称" maxLength={100} />
        <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <textarea rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="工作流目标" />
        <input type="datetime-local" value={nextRun} onChange={(event) => setNextRun(event.target.value)} />
        <div className="schedule-frequency"><button className={frequency === "once" ? "active" : ""} onClick={() => setFrequency("once")}>单次</button><button className={frequency === "interval" ? "active" : ""} onClick={() => setFrequency("interval")}>循环</button>{frequency === "interval" && <label><input type="number" min={1} max={43200} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} />分钟</label>}</div>
        <div className="workflow-form-actions"><button className="panel-action-btn" onClick={() => setShowCreate(false)}>取消</button><button className="panel-action-btn primary" disabled={!name.trim() || !goal.trim() || !workspace || busy !== null} onClick={() => void create()}>{busy === "create" ? <SpinnerIcon size={11} className="spin" /> : <ClockIcon size={11} />}保存</button></div>
      </div>}
      {schedules.length === 0 && !showCreate ? <div className="right-empty compact"><span>暂无定时计划</span></div> : schedules.map((schedule) => <div className="schedule-item" key={schedule.id}>
        <button className={`schedule-toggle ${schedule.enabled ? "on" : ""}`} title={schedule.enabled ? "停用计划" : "启用计划"} onClick={() => void update(schedule.id, { enabled: !schedule.enabled })}><span /></button>
        <div className="schedule-main"><strong>{schedule.name}</strong><span>{schedule.frequency === "interval" ? `每 ${schedule.intervalMinutes} 分钟` : "单次"} · {new Date(schedule.nextRunAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span></div>
        <button className="icon-action-btn" title="立即运行" disabled={busy !== null} onClick={() => void runNow(schedule.id)}>{busy === schedule.id ? <SpinnerIcon size={11} className="spin" /> : <PlayIcon size={11} />}</button>
        <button className="icon-action-btn" title="删除计划" disabled={busy !== null} onClick={() => void remove(schedule.id)}><Trash2Icon size={11} /></button>
      </div>)}
    </div>
  )
}

function defaultDateTime(): string {
  const date = new Date(Date.now() + 60 * 60_000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
