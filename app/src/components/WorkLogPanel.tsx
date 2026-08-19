import { useEffect, useMemo, useState } from "react"
import type { WorkLogEntry } from "../store"
import {
  activityEntryLabel,
  activityWindow,
  buildActivityHeadline,
} from "../agent-activity-feed"
import { TOOL_EXECUTION_UNDONE_EVENT, undoToolExecution } from "../tool-executions"
import {
  AlertCircleIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon,
  FileCodeIcon, RotateCcwIcon, SearchIcon, SpinnerIcon, TerminalIcon, WifiIcon,
} from "./Icons"

interface WorkLogPanelProps {
  entries: WorkLogEntry[]
  isStreaming?: boolean
  activeLabel?: string
  connectionStatus?: "connected" | "disconnected" | "connecting"
  reconnectAttempt?: number
}

export function WorkLogPanel({
  entries,
  isStreaming = false,
  activeLabel,
  connectionStatus = "connected",
  reconnectAttempt = 0,
}: WorkLogPanelProps) {
  const [open, setOpen] = useState(true)
  const [showHistory, setShowHistory] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [undoing, setUndoing] = useState<string | null>(null)
  const [undone, setUndone] = useState<Set<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const headline = useMemo(() => buildActivityHeadline({
    entries, isStreaming, activeLabel, connectionStatus, reconnectAttempt,
  }), [activeLabel, connectionStatus, entries, isStreaming, reconnectAttempt])
  const activity = useMemo(() => activityWindow(entries), [entries])
  const activityCount = activity.hidden.length + activity.visible.length
  const displayedEntries = showHistory ? [...activity.hidden, ...activity.visible] : activity.visible

  useEffect(() => {
    const onUndone = (event: Event) => {
      const executionId = (event as CustomEvent<{ executionId?: string }>).detail?.executionId
      const entry = entries.find((item) => item.executionId === executionId)
      if (entry) setUndone((current) => new Set(current).add(entry.id))
    }
    window.addEventListener(TOOL_EXECUTION_UNDONE_EVENT, onUndone)
    return () => window.removeEventListener(TOOL_EXECUTION_UNDONE_EVENT, onUndone)
  }, [entries])

  useEffect(() => {
    if (isStreaming || connectionStatus === "connecting") setOpen(true)
  }, [connectionStatus, isStreaming])

  const toggleEntry = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const undo = async (entry: WorkLogEntry) => {
    if (!entry.executionId) return
    setUndoing(entry.id)
    setErrors((current) => ({ ...current, [entry.id]: "" }))
    try {
      await undoToolExecution(entry.executionId)
      setUndone((current) => new Set(current).add(entry.id))
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [entry.id]: error instanceof Error ? error.message : String(error),
      }))
      setExpanded((current) => new Set(current).add(entry.id))
    } finally {
      setUndoing(null)
    }
  }

  // 已被根任务自动恢复的工具尝试只保留在诊断日志中，不再渲染成用户待处理错误。
  if (!isStreaming && connectionStatus !== "connecting" && activityCount === 0) return null

  return (
    <section className={`work-log-panel ${headline.tone}`} aria-label="Agent 执行过程">
      <button
        type="button"
        className="work-log-header"
        onClick={() => activityCount > 0 && setOpen(!open)}
        aria-expanded={activityCount > 0 ? open : undefined}
        disabled={activityCount === 0}
      >
        <span className="work-log-headline-icon"><HeadlineIcon tone={headline.tone} /></span>
        <span className="work-log-headline">{headline.text}</span>
        {activityCount > 0 && (
          <>
            <span className="work-log-count">{activityCount}</span>
            <span className="work-log-header-chevron">
              {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            </span>
          </>
        )}
      </button>
      {open && activityCount > 0 && (
        <div className="work-log-list">
          {activity.hidden.length > 0 && !showHistory && (
            <button type="button" className="work-log-history" onClick={() => setShowHistory(true)}>
              查看此前 {activity.hidden.length} 项操作
            </button>
          )}
          {showHistory && activity.hidden.length > 0 && (
            <button type="button" className="work-log-history" onClick={() => setShowHistory(false)}>
              收起较早操作
            </button>
          )}
          {displayedEntries.map((entry) => {
            const hasDetails = Boolean(entry.diff || entry.detail || entry.error || errors[entry.id])
            const isExpanded = expanded.has(entry.id)
            const isUndone = Boolean(entry.undoneAt || undone.has(entry.id))
            return (
              <div key={entry.id} className={`work-log-entry ${entry.status}`}>
                <div className="work-log-summary">
                  <button
                    type="button"
                    className="work-log-expand"
                    onClick={() => hasDetails && toggleEntry(entry.id)}
                    disabled={!hasDetails}
                    aria-expanded={hasDetails ? isExpanded : undefined}
                    title={hasDetails ? "查看详情" : undefined}
                  >
                    <span className="work-log-chevron">
                      {hasDetails ? isExpanded ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} /> : null}
                    </span>
                    <span className="work-log-icon"><WorkIcon entry={entry} /></span>
                    <span className="work-log-label">{activityEntryLabel(entry)}</span>
                    {entry.fileName && <span className="work-log-file">{entry.fileName}</span>}
                    {entry.linesChanged && (
                      <span className="work-log-lines">
                        <span className="added">+{entry.linesChanged.added}</span>
                        <span className="removed">-{entry.linesChanged.removed}</span>
                      </span>
                    )}
                    <span className="work-log-time">{formatTime(entry.timestamp)}</span>
                  </button>
                  {entry.status === "running" && <SpinnerIcon size={12} className="spin" />}
                  {entry.reversible && !isUndone && (
                    <button
                      type="button"
                      className="work-log-undo"
                      onClick={() => void undo(entry)}
                      disabled={undoing === entry.id}
                      title="撤销本次文件变更"
                    >
                      {undoing === entry.id ? <SpinnerIcon size={12} className="spin" /> : <RotateCcwIcon size={12} />}
                      <span>撤销</span>
                    </button>
                  )}
                  {isUndone && <span className="work-log-undone"><CheckCircleIcon size={12} />已撤销</span>}
                </div>
                {isExpanded && (
                  <div className="work-log-details">
                    {entry.filePath && <div className="work-log-path">{entry.filePath}</div>}
                    {entry.detail && <div className="work-log-detail">{entry.detail}</div>}
                    {(entry.error || errors[entry.id]) && (
                      <div className="work-log-error"><AlertCircleIcon size={12} />{errors[entry.id] || entry.error}</div>
                    )}
                    {entry.diff && <DiffView diff={entry.diff} />}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function HeadlineIcon({ tone }: { tone: ReturnType<typeof buildActivityHeadline>["tone"] }) {
  if (tone === "reconnecting") return <WifiIcon size={15} />
  if (tone === "error") return <AlertCircleIcon size={15} />
  if (tone === "complete") return <CheckCircleIcon size={15} />
  return <SpinnerIcon size={15} className="spin" />
}

function WorkIcon({ entry }: { entry: WorkLogEntry }) {
  if (entry.status === "error") return <AlertCircleIcon size={12} />
  if (entry.status === "running") return <SpinnerIcon size={12} className="spin" />
  if (entry.type === "edit") return <FileCodeIcon size={12} />
  if (entry.type === "execute") return <TerminalIcon size={12} />
  return <SearchIcon size={12} />
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="work-log-diff" aria-label="文件变更">
      {diff.split("\n").map((line, index) => (
        <span key={`${index}-${line}`} className={diffLineClass(line)}>{line || " "}{"\n"}</span>
      ))}
    </pre>
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk"
  if (line.startsWith("+") && !line.startsWith("+++")) return "addition"
  if (line.startsWith("-") && !line.startsWith("---")) return "deletion"
  if (line.startsWith("---") || line.startsWith("+++")) return "header"
  return "context"
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
}
