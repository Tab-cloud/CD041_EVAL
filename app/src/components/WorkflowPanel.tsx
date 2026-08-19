import { useCallback, useEffect, useState } from "react"
import { apiFetch } from "../api"
import {
  ActivityIcon, AlertCircleIcon, BellIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon,
  GitBranchIcon, PlayIcon, PlusIcon, RefreshCwIcon, SpinnerIcon,
} from "./Icons"
import { WorkflowAnalyticsPanel } from "./WorkflowAnalyticsPanel"
import { WorkflowRunDetails } from "./WorkflowRunDetails"
import { WorkflowSchedulePanel } from "./WorkflowSchedulePanel"
import { WorkflowTemplateEditor } from "./WorkflowTemplateEditor"
import type { WorkflowRun, WorkflowTemplate } from "./workflow-types"

interface Props { sessionId: string; workspace: string; notificationsEnabled: boolean; onToggleNotifications: () => void }

export function WorkflowPanel({ sessionId, workspace, notificationsEnabled, onToggleNotifications }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowRun[]>([])
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [section, setSection] = useState<"runs" | "schedules" | "templates" | "analytics">("runs")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [templateId, setTemplateId] = useState("quick-prototype")
  const [goal, setGoal] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [humanResult, setHumanResult] = useState<Record<string, string>>({})
  const [reportId, setReportId] = useState<string | null>(null)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/workflows?sessionId=${encodeURIComponent(sessionId)}`)
      const payload = await response.json().catch(() => ({})) as { workflows?: WorkflowRun[]; templates?: WorkflowTemplate[]; error?: string }
      if (!response.ok) throw new Error(payload.error || `工作流加载失败: HTTP ${response.status}`)
      setWorkflows(payload.workflows ?? [])
      setTemplates(payload.templates ?? [])
      setTemplateId((current) => payload.templates?.some((item) => item.id === current) ? current : (payload.templates?.[0]?.id ?? ""))
      setError("")
    } catch (reason) { setError(messageOf(reason)) }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [refresh])

  const create = async () => {
    if (!goal.trim() || !templateId || !workspace) return
    setBusy("create")
    try {
      const response = await apiFetch("/api/workflows", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, templateId, goal, workingDir: workspace }),
      })
      const payload = await response.json().catch(() => ({})) as { workflow?: WorkflowRun; error?: string }
      if (!response.ok || !payload.workflow) throw new Error(payload.error || "工作流创建失败")
      setGoal(""); setShowCreate(false); setExpanded(payload.workflow.id)
      await refresh()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const act = async (workflowId: string, action: string, nodeId?: string, result?: string) => {
    const key = `${workflowId}:${action}:${nodeId ?? ""}`
    setBusy(key)
    try {
      const response = await apiFetch("/api/workflows/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId, action, nodeId, result }),
      })
      const payload = await response.json().catch(() => ({})) as { workflow?: WorkflowRun; error?: string }
      if (!response.ok) throw new Error(payload.error || `操作失败: HTTP ${response.status}`)
      if (action === "replay" && payload.workflow) setExpanded(payload.workflow.id)
      setError("")
      await refresh()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const remove = async (id: string) => {
    setBusy(`${id}:delete`)
    try {
      const response = await apiFetch(`/api/workflows?id=${encodeURIComponent(id)}`, { method: "DELETE" })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "删除失败")
      await refresh()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  return (
    <div className="workflow-panel">
      <div className="workflow-subnav">
        <button className={section === "runs" ? "active" : ""} onClick={() => setSection("runs")}>运行</button>
        <button className={section === "schedules" ? "active" : ""} onClick={() => setSection("schedules")}><ClockIcon size={11} />定时</button>
        <button className={section === "templates" ? "active" : ""} onClick={() => setSection("templates")}><GitBranchIcon size={11} />模板</button>
        <button className={section === "analytics" ? "active" : ""} onClick={() => setSection("analytics")}><ActivityIcon size={11} />分析</button>
        <button className={`icon-action-btn ${notificationsEnabled ? "active" : ""}`} title={notificationsEnabled ? "关闭工作流通知" : "开启工作流通知"} onClick={onToggleNotifications}><BellIcon size={12} /></button>
        <button className="icon-action-btn" title="刷新工作流" onClick={() => void refresh()}><RefreshCwIcon size={12} /></button>
        {section === "runs" && <button className="icon-action-btn" title="新建工作流" onClick={() => setShowCreate((value) => !value)}><PlusIcon size={13} /></button>}
      </div>
      {error && <div className="tasks-error"><AlertCircleIcon size={12} />{error}</div>}
      {section === "templates" ? <WorkflowTemplateEditor templates={templates} onChanged={refresh} />
        : section === "schedules" ? <WorkflowSchedulePanel sessionId={sessionId} workspace={workspace} templates={templates} />
        : section === "analytics" ? <WorkflowAnalyticsPanel sessionId={sessionId} /> : (
        <>
          {showCreate && (
            <div className="workflow-create-form">
              <select value={templateId} onChange={(event) => setTemplateId(event.target.value)} aria-label="工作流模板">
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
              <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="工作流目标" rows={3} maxLength={50_000} />
              <div className="workflow-form-actions">
                <button className="panel-action-btn" onClick={() => setShowCreate(false)}>取消</button>
                <button className="panel-action-btn primary" disabled={!goal.trim() || !workspace || busy !== null} onClick={() => void create()}>
                  {busy === "create" ? <SpinnerIcon size={11} className="spin" /> : <PlayIcon size={11} />}开始
                </button>
              </div>
            </div>
          )}
          {!workspace && <div className="tasks-error"><AlertCircleIcon size={12} />请先选择工作空间</div>}
          {workflows.length === 0 && !showCreate ? <div className="right-empty compact"><span>当前会话暂无工作流</span></div> : (
            <div className="workflow-list">
              {workflows.map((run) => {
                const open = expanded === run.id
                return (
                  <section key={run.id} className={`workflow-run ${run.status}`}>
                    <button className="workflow-run-header" onClick={() => setExpanded(open ? null : run.id)}>
                      {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                      <span className="workflow-run-title" title={run.goal}>{run.goal}</span>
                      <span className={`workflow-status ${run.status}`}>{statusLabel(run.status)}</span>
                    </button>
                    {open && (
                      <WorkflowRunDetails run={run} busy={busy} reportOpen={reportId === run.id} humanResult={humanResult}
                        onHumanResult={(nodeId, value) => setHumanResult((current) => ({ ...current, [nodeId]: value }))}
                        onAction={act} onReport={() => setReportId(reportId === run.id ? null : run.id)} onDelete={remove} />
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function statusLabel(status: WorkflowRun["status"]): string { return ({ planned: "待开始", running: "运行中", pausing: "暂停中", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消" })[status] }
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
