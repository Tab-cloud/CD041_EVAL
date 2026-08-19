import { useState } from "react"
import type { SessionMeta } from "../store"
import { PlusIcon, FolderIcon, FlameIcon, Trash2Icon, SpinnerIcon } from "./Icons"
import { useI18n, type TranslationKey } from "../i18n"
import { TokenHeatmap } from "./TokenHeatmap"

/** 相对时间格式化 */
function relTime(ts: number, t: (key: TranslationKey, values?: Record<string, string | number>) => string): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return t("time.justNow")
  if (m < 60) return t("time.minutesShort", { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t("time.hoursShort", { count: h })
  const d = Math.floor(h / 24)
  if (d < 30) return t("time.daysShort", { count: d })
  const mo = Math.floor(d / 30)
  return t("time.monthsShort", { count: mo })
}

interface LeftSidebarProps {
  sessions: SessionMeta[]
  activeSessionId: string | null
  isStreaming: boolean
  collapsed: boolean
  width?: number
  onSelectSession: (id: string) => void
  onNewSession: () => void
  onArchiveSession: (id: string) => Promise<void>
  onDeleteSession: (id: string) => void
}

export function LeftSidebar({ sessions, activeSessionId, isStreaming, collapsed, width, onSelectSession, onNewSession, onArchiveSession, onDeleteSession }: LeftSidebarProps) {
  const { t } = useI18n()
  const [archiving, setArchiving] = useState<Set<string>>(new Set())
  const [ashed, setAshed] = useState<Set<string>>(new Set())

  const activeSessions = sessions.filter(s => !s.archived || archiving.has(s.id) || ashed.has(s.id))

  const [listTab, setListTab] = useState<"sessions" | "projects">("sessions")

  const renderSessionItem = (s: SessionMeta) => (
    <div key={s.id}
      className={`session-list-item ${activeSessionId === s.id ? "active" : ""} ${s.archived ? "archived" : ""}`}
      onClick={() => onSelectSession(s.id)}>
      <span className="session-title">{s.title}</span>
      {activeSessionId === s.id && isStreaming ? (
        <span className="session-spinner"><SpinnerIcon size={11} className="spin" /></span>
      ) : (
        <span className="session-time">{relTime(s.updatedAt, t)}</span>
      )}
      {s.archived || ashed.has(s.id) ? (
        <span className="session-archived-badge" title={s.summary ?? ""}>{t("sidebar.archived")}</span>
      ) : (
        <button
          className={`session-archive-btn ${archiving.has(s.id) ? "burning" : ""} ${ashed.has(s.id) ? "ash" : ""}`}
          onClick={async (e) => {
            e.stopPropagation()
            if (archiving.has(s.id)) return
            setArchiving((p) => new Set(p).add(s.id))
            try { await onArchiveSession(s.id) } finally {
              setArchiving((p) => { const n = new Set(p); n.delete(s.id); return n })
              setAshed((p) => new Set(p).add(s.id))
              setTimeout(() => setAshed((p) => { const n = new Set(p); n.delete(s.id); return n }), 1200)
            }
          }}
          title={t("sidebar.archive")}><span className="flame-icon"><FlameIcon size={12} /></span></button>
      )}
      <button className="session-delete-btn" onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id) }} title={t("sidebar.delete")}>
        <Trash2Icon size={12} />
      </button>
    </div>
  )

  return (
    <div className={`sidebar ${collapsed ? "collapsed" : ""}`} style={!collapsed && width ? { width, flexShrink: 0 } : undefined}>
      <div className="sidebar-top">
        <span className="sidebar-heading">{t("sidebar.workspace")}</span>
        <button className="sidebar-new-btn" onClick={onNewSession} title={t("sidebar.newTask")}>
          <PlusIcon size={12} /><span>{t("sidebar.new")}</span>
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="sidebar-tabs">
            <button className={`sidebar-tab ${listTab === "sessions" ? "active" : ""}`} onClick={() => setListTab("sessions")}>
              {t("sidebar.sessions")}
            </button>
            <button className={`sidebar-tab ${listTab === "projects" ? "active" : ""}`} onClick={() => setListTab("projects")}>
              {t("sidebar.projects")}
            </button>
          </div>

          <div className="sidebar-section" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {activeSessions.length === 0 && <div className="sidebar-empty">{t("sidebar.empty")}</div>}
            {activeSessions.length > 0 && (
              <div className="session-list-scroll">
                {/* 会话 Tab: 平铺列表（全部渲染，靠滚动容器限制可见高度） */}
                {listTab === "sessions" && [...activeSessions]
                      .sort((a, b) => b.updatedAt - a.updatedAt)
                      .map((s) => renderSessionItem(s))}
                    {/* 项目 Tab: 按 projectPath 分组 */}
                    {listTab === "projects" && (() => {
                      const groups = new Map<string, SessionMeta[]>()
                      for (const s of activeSessions) {
                        const key = s.projectPath ?? "(未分配)"
                        if (!groups.has(key)) groups.set(key, [])
                        groups.get(key)!.push(s)
                      }
                      const sorted = [...groups.entries()].sort((a, b) => {
                        const aMax = Math.max(...a[1].map(s => s.updatedAt))
                        const bMax = Math.max(...b[1].map(s => s.updatedAt))
                        return bMax - aMax
                      })
                        return sorted.map(([projectPath, sessions]) => {
                          const folderName = projectPath === "(未分配)" ? t("sidebar.unassigned") : projectPath.split(/[/\\]/).pop() ?? projectPath
                          return (
                            <div key={projectPath} className="session-project-group">
                              <div className="session-project-header">
                                <FolderIcon size={12} />
                                <span className="session-project-name">{folderName}</span>
                                <span className="session-project-count">{sessions.length}</span>
                              </div>
                              {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => renderSessionItem(s))}
                            </div>
                          )
                        })
                      })()}
                    </div>
                  )}
          </div>
          <TokenHeatmap
            activeSessionId={activeSessionId}
            isStreaming={isStreaming}
          />
        </>
      )}
    </div>
  )
}
