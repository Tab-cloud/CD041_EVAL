import { useEffect, useMemo, useState } from "react"
import type { WorkLogEntry } from "../store"
import { TOOL_EXECUTION_UNDONE_EVENT, undoToolExecution } from "../tool-executions"
import {
  AlertCircleIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon,
  FileCodeIcon, RotateCcwIcon, SpinnerIcon,
} from "./Icons"

interface ChangeGroup {
  path: string
  fileName: string
  entries: WorkLogEntry[]
  added: number
  removed: number
}

export function ChangesPanel({ entries }: { entries: WorkLogEntry[] }) {
  const changes = entries.filter((entry) => entry.type === "edit")
  const groups = useMemo(() => groupChanges(changes), [changes])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [undone, setUndone] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    const listener = (event: Event) => {
      const executionId = (event as CustomEvent<{ executionId?: string }>).detail?.executionId
      if (executionId) setUndone((current) => new Set(current).add(executionId))
    }
    window.addEventListener(TOOL_EXECUTION_UNDONE_EVENT, listener)
    return () => window.removeEventListener(TOOL_EXECUTION_UNDONE_EVENT, listener)
  }, [])

  const undoEntry = async (entry: WorkLogEntry) => {
    if (!entry.executionId) return
    setBusy(entry.executionId)
    setErrors((current) => ({ ...current, [entry.executionId!]: "" }))
    try {
      await undoToolExecution(entry.executionId)
      setUndone((current) => new Set(current).add(entry.executionId!))
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [entry.executionId!]: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setBusy(null)
    }
  }

  const undoAll = async () => {
    const reversible = changes
      .filter((entry) => entry.executionId && entry.reversible && !entry.undoneAt && !undone.has(entry.executionId))
      .sort((a, b) => b.timestamp - a.timestamp)
    setBusy("all")
    for (const entry of reversible) {
      try {
        await undoToolExecution(entry.executionId!)
        setUndone((current) => new Set(current).add(entry.executionId!))
      } catch (error) {
        setErrors((current) => ({
          ...current,
          [entry.executionId!]: error instanceof Error ? error.message : String(error),
        }))
      }
    }
    setBusy(null)
  }

  if (changes.length === 0) {
    return <div className="right-empty"><FileCodeIcon size={34} /><span>当前会话暂无文件变更</span></div>
  }

  const reversibleCount = changes.filter((entry) => entry.executionId && entry.reversible && !entry.undoneAt && !undone.has(entry.executionId)).length
  const totalAdded = changes.reduce((sum, entry) => sum + (entry.linesChanged?.added ?? 0), 0)
  const totalRemoved = changes.reduce((sum, entry) => sum + (entry.linesChanged?.removed ?? 0), 0)
  return (
    <div className="changes-panel">
      <div className="changes-summary">
        <div><strong>{groups.length}</strong> 个文件 <span className="change-added">+{totalAdded}</span> <span className="change-removed">-{totalRemoved}</span></div>
        {reversibleCount > 0 && (
          <button type="button" className="panel-action-btn" onClick={() => void undoAll()} disabled={busy !== null}>
            {busy === "all" ? <SpinnerIcon size={12} className="spin" /> : <RotateCcwIcon size={12} />}
            撤销全部
          </button>
        )}
      </div>
      <div className="change-groups">
        {groups.map((group) => {
          const isOpen = expanded.has(group.path)
          return (
            <section key={group.path} className="change-group">
              <button type="button" className="change-group-header" onClick={() => setExpanded(toggleSet(expanded, group.path))} aria-expanded={isOpen}>
                {isOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                <FileCodeIcon size={13} />
                <span className="change-file" title={group.path}>{group.fileName}</span>
                <span className="change-count">{group.entries.length}</span>
                <span className="change-stats"><span className="change-added">+{group.added}</span><span className="change-removed">-{group.removed}</span></span>
              </button>
              {isOpen && <div className="change-group-path">{group.path}</div>}
              {isOpen && group.entries.slice().reverse().map((entry) => {
                const isUndone = Boolean(entry.undoneAt || (entry.executionId && undone.has(entry.executionId)))
                const error = entry.executionId ? errors[entry.executionId] : ""
                return (
                  <div key={entry.id} className="change-item">
                    <div className="change-item-head">
                      <span>{new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                      {entry.linesChanged && <span><span className="change-added">+{entry.linesChanged.added}</span> <span className="change-removed">-{entry.linesChanged.removed}</span></span>}
                      {entry.reversible && !isUndone && (
                        <button type="button" className="icon-action-btn" title="撤销本次变更" onClick={() => void undoEntry(entry)} disabled={busy !== null}>
                          {busy === entry.executionId ? <SpinnerIcon size={12} className="spin" /> : <RotateCcwIcon size={12} />}
                        </button>
                      )}
                      {isUndone && <span className="change-undone"><CheckCircleIcon size={12} />已撤销</span>}
                    </div>
                    {error && <div className="change-error"><AlertCircleIcon size={12} />{error}</div>}
                    {entry.diff && <DiffBlock diff={entry.diff} />}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function groupChanges(entries: WorkLogEntry[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>()
  for (const entry of entries) {
    const path = [entry.filePath, entry.fileName].filter(Boolean).join("/") || "未知文件"
    const group = groups.get(path) ?? { path, fileName: entry.fileName ?? path, entries: [], added: 0, removed: 0 }
    group.entries.push(entry)
    group.added += entry.linesChanged?.added ?? 0
    group.removed += entry.linesChanged?.removed ?? 0
    groups.set(path, group)
  }
  return [...groups.values()].sort((a, b) => Math.max(...b.entries.map((entry) => entry.timestamp)) - Math.max(...a.entries.map((entry) => entry.timestamp)))
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function DiffBlock({ diff }: { diff: string }) {
  return <pre className="change-diff">{diff.split("\n").map((line, index) => <span key={`${index}-${line}`} className={lineClass(line)}>{line || " "}{"\n"}</span>)}</pre>
}

function lineClass(line: string): string {
  if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) return "meta"
  if (line.startsWith("+")) return "addition"
  if (line.startsWith("-")) return "deletion"
  return "context"
}
