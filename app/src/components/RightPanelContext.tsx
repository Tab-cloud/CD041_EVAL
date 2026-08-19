import { useState } from "react"
import type { CompactSummary, FollowupItem, TodoItem } from "../store"
import { ContextUsagePanel } from "./ContextUsagePanel"
import {
  CheckCircleIcon, ChevronDownIcon, CircleIcon, FileCodeIcon, GaugeIcon, SpinnerIcon,
} from "./Icons"
import type { ContextUsageSnapshot } from "../context-state"

interface Props {
  contextUsage: ContextUsageSnapshot | null
  todos: TodoItem[]
  followups: FollowupItem[]
  compactSummary: CompactSummary | null
  isCompacting: boolean
  isStreaming: boolean
}

export function RightPanelContext({ contextUsage, todos, followups, compactSummary, isCompacting, isStreaming }: Props) {
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const empty = !isCompacting && !compactSummary && todos.length === 0 && followups.length === 0 && !contextUsage
  return (
    <div>
      {isCompacting && (
        <div className="context-card context-compacting-card" role="status" aria-live="polite">
          <SpinnerIcon size={14} className="spin" />
          <div><strong>正在压缩上下文</strong><span>正在生成并保存会话摘要，完成后容量会重新估算。</span></div>
        </div>
      )}
      {contextUsage && <ContextUsagePanel snapshot={contextUsage} />}
      {compactSummary && (
        <div className="context-card compact-summary-card">
          <button type="button" className="compact-summary-toggle" onClick={() => setSummaryExpanded(!summaryExpanded)} aria-expanded={summaryExpanded}>
            <FileCodeIcon size={13} />
            <h4>上下文压缩摘要</h4>
            <span className="compact-summary-mode">{compactModeLabel(compactSummary.mode)}</span>
            <span className="compact-summary-time">{formatTime(compactSummary.timestamp)}</span>
            <ChevronDownIcon size={11} className={summaryExpanded ? "expanded" : ""} />
          </button>
          {summaryExpanded && (
            <div className="compact-summary-body">
              {compactSummary.originalTokens !== undefined && compactSummary.compactedTokens !== undefined && (
                <div className="compact-summary-metrics">
                  压缩前 {formatTokens(compactSummary.originalTokens)} · 压缩后 {formatTokens(compactSummary.compactedTokens)}
                </div>
              )}
              {parseSummary(compactSummary.content).map((section) => (
                <div key={section.title} className="compact-section">
                  <div className="compact-section-title">{section.title}</div>
                  <ul className="compact-section-list">
                    {section.items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <TodoList todos={todos} isStreaming={isStreaming} />
      <FollowupList followups={followups} />
      {empty && <div className="right-empty compact"><GaugeIcon size={28} /><span>发送消息后，这里会显示上下文容量、压缩摘要和任务清单。</span></div>}
    </div>
  )
}

function FollowupList({ followups }: { followups: FollowupItem[] }) {
  if (followups.length === 0) return null
  return (
    <div className="context-card followup-card">
      <h4>后续实机验证 <span className="todo-count">{followups.length}</span></h4>
      <div className="followup-description">这些操作需要你连接硬件后手动完成，不影响当前 Agent 任务交付。</div>
      <div className="todo-list">
        {followups.map((followup, index) => (
          <div key={`${index}-${followup.content}`} className="todo-item todo-followup">
            <span className="todo-icon"><CircleIcon size={13} /></span>
            <span className="todo-content">
              {followup.content}
              {followup.reason && <small>{followup.reason}</small>}
            </span>
            <span className="todo-state-label">用户后续</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TodoList({ todos, isStreaming }: { todos: TodoItem[]; isStreaming: boolean }) {
  if (todos.length === 0) return null
  const completed = todos.filter((todo) => todo.status === "completed").length
  const progress = Math.round((completed / todos.length) * 100)
  return (
    <div className="context-card todo-card">
      <h4>任务清单 <span className="todo-count">{completed}/{todos.length}</span></h4>
      <div className="todo-progress-track"><div className="todo-progress-fill" style={{ width: `${progress}%` }} /></div>
      <div className="todo-list">
        {todos.map((todo, index) => (
          <div key={`${index}-${todo.content}`} className={`todo-item todo-${todo.status}`}>
            <span className="todo-icon">
              {todo.status === "completed" ? <CheckCircleIcon size={13} />
                : todo.status === "in_progress" && isStreaming ? <SpinnerIcon size={13} className="spin" />
                  : <CircleIcon size={13} />}
            </span>
            <span className="todo-content">{todo.content}</span>
            {todo.status === "paused" && <span className="todo-state-label">已暂停</span>}
            {todo.status === "blocked" && <span className="todo-state-label">等待条件</span>}
            <span className={`todo-prio ${todo.priority}`}>{priorityLabel(todo.priority)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function parseSummary(content: string): Array<{ title: string; items: string[] }> {
  const cleaned = content.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").replace(/\r\n?/g, "\n").trim()
  const sections: Array<{ title: string; items: string[] }> = []
  for (const part of cleaned.split(/(?=\n\s*(?:\d+[.、]\s*|##?\s+)[^\n]+)/)) {
    const match = part.match(/^\s*(?:\d+[.、]|##?\s+)(.+?)\n([\s\S]*)$/)
    if (!match) continue
    const items = match[2].split("\n")
      .map((line) => line.replace(/^[-•*]\s*/, "").trim())
      .filter((line) => line && !line.startsWith("|"))
    if (items.length > 0) sections.push({ title: match[1].replace(/\*\*/g, "").trim(), items })
  }
  return sections.length > 0 ? sections : [{ title: "压缩摘要", items: cleaned.split("\n").filter(Boolean).slice(0, 20) }]
}

function priorityLabel(priority: TodoItem["priority"]): string {
  return priority === "high" ? "高" : priority === "medium" ? "中" : "低"
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
}

function compactModeLabel(mode?: CompactSummary["mode"]): string {
  if (mode === "auto") return "自动"
  if (mode === "fallback") return "安全摘录"
  return "手动"
}

function formatTokens(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(1)}万 token` : `${value} token`
}
