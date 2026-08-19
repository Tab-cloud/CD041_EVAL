import { useCallback, useEffect, useRef, useState } from "react"
import { apiFetch } from "../api"
import { readSse } from "../sse"
import {
  AlertCircleIcon, CheckCircleIcon, CircleIcon, GitBranchIcon, ListChecksIcon, RefreshCwIcon, SpinnerIcon, Trash2Icon,
} from "./Icons"
import { WorkflowPanel } from "./WorkflowPanel"
import { ToolApprovalCard } from "./ToolApprovalCard"
import type { ApprovalDecision } from "./ToolApprovalCard"
import type { ToolApproval } from "../store"

type TaskStatus = "queued" | "running" | "waiting-approval" | "blocked" | "completed" | "failed" | "cancelled" | "interrupted"

interface TaskRun {
  id: string
  status: TaskStatus
  message: string
  type: string
  scope?: string
  effort?: string
  problem?: { message?: string }
  createdAt: number
  startedAt?: number
  completedAt?: number
}

interface CheckpointInfo {
  hasCheckpoint: boolean
  step?: number
  tools?: string[]
  updatedAt?: number
}

interface RunGraphProjection {
  id: string
  version: number
  status: string
}

interface Props {
  sessionId: string | null
  workspace: string
  notificationsEnabled: boolean
  onToggleNotifications: () => void
  onRetry: (message: string, scope: string, effort: string, sourceTaskId?: string) => void
}

export function TasksPanel({ sessionId, workspace, notificationsEnabled, onToggleNotifications, onRetry }: Props) {
  const [view, setView] = useState<"tasks" | "workflows">("tasks")
  const [tasks, setTasks] = useState<TaskRun[]>([])
  const [checkpoint, setCheckpoint] = useState<CheckpointInfo>({ hasCheckpoint: false })
  const [approvals, setApprovals] = useState<ToolApproval[]>([])
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [graph, setGraph] = useState<RunGraphProjection | null>(null)
  const graphVersion = useRef(0)

  const refresh = useCallback(async (showLoading = false) => {
    if (!sessionId) { setTasks([]); setCheckpoint({ hasCheckpoint: false }); setApprovals([]); return }
    if (showLoading) setLoading(true)
    try {
      const response = await apiFetch(`/api/tasks?sessionId=${encodeURIComponent(sessionId)}&limit=50`)
      const payload = await response.json().catch(() => ({})) as {
        tasks?: TaskRun[]; checkpoint?: CheckpointInfo; approvals?: ToolApproval[]
        graph?: RunGraphProjection | null; error?: string
      }
      if (!response.ok) throw new Error(payload.error || `任务加载失败: HTTP ${response.status}`)
      setTasks(Array.isArray(payload.tasks) ? payload.tasks : [])
      setCheckpoint(payload.checkpoint ?? { hasCheckpoint: false })
      setApprovals(Array.isArray(payload.approvals) ? payload.approvals : [])
      setGraph(payload.graph ?? null)
      graphVersion.current = payload.graph?.version ?? 0
      setError("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  const respondToApproval = async (approval: ToolApproval, decision: ApprovalDecision) => {
    const response = await apiFetch("/api/approvals/respond", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: approval.id, decision }),
    })
    const payload = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new Error(payload.error || `审批提交失败: HTTP ${response.status}`)
    setApprovals((current) => current.filter((item) => item.id !== approval.id))
    await refresh()
  }

  useEffect(() => {
    void refresh(true)
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (!graph?.id) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await apiFetch(
          `/api/run-graphs/${encodeURIComponent(graph.id)}/stream?afterVersion=${graphVersion.current}`,
          { signal: controller.signal },
        )
        if (!response.ok || !response.body) throw new Error(`运行图订阅失败: HTTP ${response.status}`)
        for await (const event of readSse(response.body)) {
          if (controller.signal.aborted || event.event !== "graph-event") continue
          const version = Number(event.data?.version)
          if (!Number.isSafeInteger(version) || version <= graphVersion.current) continue
          // A gap means the local projection is incomplete. A contiguous event
          // also refreshes from the authoritative snapshot because internal
          // child payloads are intentionally not exposed to the UI.
          graphVersion.current = version
          await refresh()
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => controller.abort()
  }, [graph?.id, refresh])

  const retry = async (task: TaskRun) => {
    setAction(task.id)
    try {
      const response = await apiFetch("/api/tasks/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id }),
      })
      const payload = await response.json().catch(() => ({})) as {
        retry?: { message: string; scope: string; effort: string; sourceTaskId?: string }
        error?: string
      }
      if (!response.ok || !payload.retry) throw new Error(payload.error || `重试失败: HTTP ${response.status}`)
      onRetry(payload.retry.message, payload.retry.scope, payload.retry.effort, payload.retry.sourceTaskId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAction(null)
    }
  }

  const resume = async () => {
    if (!sessionId) return
    setAction("resume")
    try {
      const response = await apiFetch("/api/checkpoint/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
      const payload = await response.json().catch(() => ({})) as { resumePrompt?: string; error?: string }
      if (!response.ok || !payload.resumePrompt) throw new Error(payload.error || "检查点已失效")
      onRetry(payload.resumePrompt, "auto-edit", "on")
      setCheckpoint({ hasCheckpoint: false })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAction(null)
    }
  }

  const discard = async () => {
    if (!sessionId) return
    setAction("discard")
    try {
      const response = await apiFetch(`/api/checkpoint?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" })
      if (!response.ok) throw new Error(`放弃恢复失败: HTTP ${response.status}`)
      setCheckpoint({ hasCheckpoint: false })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setAction(null)
    }
  }

  if (!sessionId) return <div className="right-empty"><CircleIcon size={32} /><span>选择会话后查看任务</span></div>
  if (view === "workflows") return (
    <div className="tasks-panel">
      <TaskViewSwitch view={view} onChange={setView} />
      {approvals.map((approval) => <ToolApprovalCard key={approval.id} approval={approval} onDecision={(decision) => respondToApproval(approval, decision)} />)}
      <WorkflowPanel sessionId={sessionId} workspace={workspace} notificationsEnabled={notificationsEnabled} onToggleNotifications={onToggleNotifications} />
    </div>
  )
  const hasActiveTask = tasks.some((task) => task.status === "queued" || task.status === "running" || task.status === "waiting-approval")
  return (
    <div className="tasks-panel">
      <TaskViewSwitch view={view} onChange={setView} />
      {approvals.map((approval) => <ToolApprovalCard key={approval.id} approval={approval} onDecision={(decision) => respondToApproval(approval, decision)} />)}
      <div className="tasks-toolbar">
        <span>最近任务</span>
        <button type="button" className="icon-action-btn" title="刷新任务" onClick={() => void refresh(true)} disabled={loading}>
          <RefreshCwIcon size={13} className={loading ? "spin" : ""} />
        </button>
      </div>
      {checkpoint.hasCheckpoint && (
        <section className="checkpoint-banner">
          <div className="checkpoint-title"><AlertCircleIcon size={14} />检测到中断检查点</div>
          <div className="checkpoint-detail">第 {checkpoint.step ?? "-"} 步{checkpoint.tools?.length ? ` · ${checkpoint.tools.join("、")}` : ""}</div>
          <div className="checkpoint-actions">
            <button type="button" className="panel-action-btn primary" onClick={() => void resume()} disabled={action !== null || hasActiveTask}>
              {action === "resume" ? <SpinnerIcon size={12} className="spin" /> : <RefreshCwIcon size={12} />}检查后继续
            </button>
            <button type="button" className="panel-action-btn" onClick={() => void discard()} disabled={action !== null}>
              <Trash2Icon size={12} />放弃
            </button>
          </div>
        </section>
      )}
      {error && <div className="tasks-error"><AlertCircleIcon size={12} />{error}</div>}
      {tasks.length === 0 && !loading ? <div className="right-empty compact"><span>当前会话暂无任务记录</span></div> : (
        <div className="task-run-list">
          {tasks.map((task) => (
            <div key={task.id} className={`task-run ${task.status}`}>
              <div className="task-run-icon"><TaskStatusIcon status={task.status} /></div>
              <div className="task-run-main">
                <div className="task-run-message" title={task.message}>{task.message || task.type}</div>
                <div className="task-run-meta">
                  <span>{statusLabel(task.status)}</span>
                  <span>{formatDuration(task)}</span>
                  <span>{new Date(task.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                {task.problem?.message && <div className="task-run-error">{task.problem.message}</div>}
              </div>
              {["blocked", "failed", "cancelled", "interrupted"].includes(task.status) && (
                <button type="button" className="icon-action-btn" title={hasActiveTask ? "请等待当前任务结束" : "重试任务"} onClick={() => void retry(task)} disabled={action !== null || hasActiveTask}>
                  {action === task.id ? <SpinnerIcon size={12} className="spin" /> : <RefreshCwIcon size={12} />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TaskViewSwitch({ view, onChange }: { view: "tasks" | "workflows"; onChange: (view: "tasks" | "workflows") => void }) {
  return (
    <div className="task-view-switch" role="tablist" aria-label="任务视图">
      <button type="button" role="tab" aria-selected={view === "tasks"} className={view === "tasks" ? "active" : ""} onClick={() => onChange("tasks")}><ListChecksIcon size={12} />任务</button>
      <button type="button" role="tab" aria-selected={view === "workflows"} className={view === "workflows" ? "active" : ""} onClick={() => onChange("workflows")}><GitBranchIcon size={12} />工作流</button>
    </div>
  )
}

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  if (status === "running" || status === "queued") return <SpinnerIcon size={13} className="spin" />
  if (status === "waiting-approval") return <AlertCircleIcon size={13} />
  if (status === "completed") return <CheckCircleIcon size={13} />
  if (status === "blocked" || status === "failed" || status === "interrupted") return <AlertCircleIcon size={13} />
  return <CircleIcon size={13} />
}

function statusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    queued: "排队中", running: "运行中", "waiting-approval": "等待确认", blocked: "等待条件", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断",
  }
  return labels[status]
}

function formatDuration(task: TaskRun): string {
  if (!task.startedAt) return "等待执行"
  const end = task.completedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
