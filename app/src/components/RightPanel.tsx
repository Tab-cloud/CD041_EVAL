import type { CompactSummary, ContextUsageSnapshot, DocumentItem, FollowupItem, SchematicData, TodoItem, WorkLogEntry } from "../store"
import { CircuitBoardIcon, RefreshCwIcon, Trash2Icon } from "./Icons"
import { ChangesPanel } from "./ChangesPanel"
import { ChatMarkdown } from "./ChatMarkdown"
import { RightPanelContext } from "./RightPanelContext"
import { TasksPanel } from "./TasksPanel"
import { useI18n, type TranslationKey } from "../i18n"

export type RightPanelTab = "context" | "changes" | "tasks" | "schematic" | "docs"

interface RightPanelProps {
  activeTab: RightPanelTab
  activeSessionId: string | null
  workspace: string
  workflowNotificationsEnabled: boolean
  contextUsage: ContextUsageSnapshot | null
  todos: TodoItem[]
  followups: FollowupItem[]
  schematics: SchematicData[]
  documents: DocumentItem[]
  compactSummary: CompactSummary | null
  isCompacting: boolean
  isStreaming: boolean
  workLog: WorkLogEntry[]
  collapsed: boolean
  width?: number
  onSelectTab: (tab: RightPanelTab) => void
  onRetryTask: (message: string, scope: string, effort: string, sourceTaskId?: string) => void
  onToggleWorkflowNotifications: () => void
  onRefreshArtifacts: () => Promise<unknown>
  onDeleteArtifacts: (artifactIds: string[]) => Promise<void>
}

const TABS: Array<{ id: RightPanelTab; labelKey: TranslationKey }> = [
  { id: "context", labelKey: "right.context" },
  { id: "changes", labelKey: "right.changes" },
  { id: "tasks", labelKey: "right.tasks" },
  { id: "schematic", labelKey: "right.schematic" },
  { id: "docs", labelKey: "right.docs" },
]

export function RightPanel(props: RightPanelProps) {
  const { t } = useI18n()
  return (
    <aside className={`right-panel ${props.collapsed ? "collapsed" : ""}`} style={!props.collapsed && props.width ? { width: props.width, flexShrink: 0 } : undefined}>
      {!props.collapsed && (
        <>
          <div className="right-panel-tabs">
            {TABS.map((tab) => (
              <button key={tab.id} className={`right-panel-tab ${props.activeTab === tab.id ? "active" : ""}`} onClick={() => props.onSelectTab(tab.id)}>
                {t(tab.labelKey)}
                {tab.id === "changes" && props.workLog.some((entry) => entry.type === "edit") && (
                  <span className="right-tab-count">{props.workLog.filter((entry) => entry.type === "edit").length}</span>
                )}
              </button>
            ))}
          </div>
          <div className="right-panel-content">
            {props.activeTab === "context" && <RightPanelContext contextUsage={props.contextUsage} todos={props.todos} followups={props.followups} compactSummary={props.compactSummary} isCompacting={props.isCompacting} isStreaming={props.isStreaming} />}
            {props.activeTab === "changes" && <ChangesPanel entries={props.workLog} />}
            {props.activeTab === "tasks" && <TasksPanel sessionId={props.activeSessionId} workspace={props.workspace} notificationsEnabled={props.workflowNotificationsEnabled} onToggleNotifications={props.onToggleWorkflowNotifications} onRetry={props.onRetryTask} />}
            {props.activeTab === "schematic" && <SchematicTab schematics={props.schematics} emptyText={t("right.noSchematic")} onRefresh={props.onRefreshArtifacts} onDelete={props.onDeleteArtifacts} />}
            {props.activeTab === "docs" && <DocsTab documents={props.documents} emptyText={t("right.noDocs")} onRefresh={props.onRefreshArtifacts} onDelete={props.onDeleteArtifacts} />}
          </div>
        </>
      )}
    </aside>
  )
}

function SchematicTab({ schematics, emptyText, onRefresh, onDelete }: {
  schematics: SchematicData[]
  emptyText: string
  onRefresh: () => Promise<unknown>
  onDelete: (artifactIds: string[]) => Promise<void>
}) {
  if (schematics.length === 0) return <><ArtifactToolbar onRefresh={onRefresh} /><EmptyState icon={<CircuitBoardIcon size={36} />} text={emptyText} /></>
  const groups = groupSchematics(schematics)
  return (
    <div className="schematic-tab">
      <ArtifactToolbar onRefresh={onRefresh} />
      {groups.map(({ filePath, summary, pages }) => (
        <section key={filePath} className="schematic-file">
          <header className="schematic-file-header">
            <div>
              <div className="schematic-file-title" title={filePath}>{fileName(filePath)}</div>
              <div className="schematic-file-subtitle">
                已分析 {pages.length || summary?.pageCount || 0} 页
                {(summary?.fileSize || pages[0]?.fileSize) ? ` · ${summary?.fileSize || pages[0]?.fileSize}` : ""}
                {(summary?.stale || pages.some((page) => page.stale)) ? " · 源文件已变更，请重新分析" : ""}
              </div>
            </div>
            <button className="artifact-icon-button" title="从会话资料中删除" onClick={() => void onDelete(
              [summary, ...pages].map((item) => item?.artifactId).filter((id): id is string => Boolean(id)),
            )}><Trash2Icon size={14} /></button>
          </header>

          <div className="schematic-overview">
            <div className="schematic-overview-title">整图核心摘要</div>
            <div className="schematic-report msg-bubble">
              <ChatMarkdown>{summary?.analysis || fallbackSchematicOverview(pages)}</ChatMarkdown>
            </div>
          </div>

          {pages.length > 0 && (
            <div className="schematic-pages">
              <div className="schematic-pages-title">分页详情</div>
              {pages.map((data, index) => (
                <details key={`${data.filePath}-${data.pageNumber ?? index + 1}`} className="schematic-page" open={pages.length === 1}>
                  <summary>
                    <span>第 {data.pageNumber ?? index + 1} 页</span>
                    <span className="schematic-page-meta">
                      {data.focus && data.focus !== "all" ? focusLabel(data.focus) : "完整分析"}
                      {data.elapsedMs ? ` · ${(data.elapsedMs / 1000).toFixed(1)}s` : ""}
                    </span>
                  </summary>
                  <div className="schematic-report schematic-page-report msg-bubble">
                    <ChatMarkdown>{data.analysis}</ChatMarkdown>
                  </div>
                </details>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

function groupSchematics(schematics: SchematicData[]) {
  const groups = new Map<string, SchematicData[]>()
  for (const item of schematics) {
    const values = groups.get(item.filePath) ?? []
    values.push(item)
    groups.set(item.filePath, values)
  }
  return [...groups.entries()].map(([filePath, items]) => {
    const summaries = items.filter((item) => item.kind === "summary")
    const summary = summaries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0]
    const pages = items
      .filter((item) => item.kind !== "summary")
      .sort((a, b) => (a.pageNumber ?? 1) - (b.pageNumber ?? 1))
    return { filePath, summary, pages }
  })
}

function fallbackSchematicOverview(pages: SchematicData[]): string {
  if (pages.length === 0) return "尚未形成整图摘要。"
  const pageList = pages.map((page, index) => `- 第 ${page.pageNumber ?? index + 1} 页：${firstMeaningfulLine(page.analysis)}`)
  return [`已保留 ${pages.length} 页分析结果。重新执行整图分析后，这里会显示跨页汇总的核心结论。`, "", ...pageList].join("\n")
}

function firstMeaningfulLine(content: string): string {
  const line = content.split(/\r?\n/)
    .map((value) => value.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim())
    .find((value) => value && value !== "```json" && value !== "```")
  return line?.slice(0, 80) || "已完成本页分析"
}

function focusLabel(focus: string): string {
  const labels: Record<string, string> = { mcu: "主控", power: "电源", peripherals: "外设" }
  return labels[focus] ?? focus
}

function DocsTab({ documents, emptyText, onRefresh, onDelete }: {
  documents: DocumentItem[]
  emptyText: string
  onRefresh: () => Promise<unknown>
  onDelete: (artifactIds: string[]) => Promise<void>
}) {
  if (documents.length === 0) return <><ArtifactToolbar onRefresh={onRefresh} /><EmptyState text={emptyText} /></>
  return (
    <div className="docs-tab">
      <ArtifactToolbar onRefresh={onRefresh} />
      {documents.map((doc, index) => (
        <div key={`${doc.source}-${index}`} className="context-card doc-card">
          <div className="artifact-card-heading">
            <h4>{doc.title}</h4>
            {doc.artifactId && <button className="artifact-icon-button" title="从会话资料中删除" onClick={() => void onDelete([doc.artifactId!])}><Trash2Icon size={14} /></button>}
          </div>
          <div className="doc-meta"><Meta label="来源" value={fileName(doc.source)} title={doc.source} /><Meta label="类型" value={documentType(doc.type)} /></div>
          {doc.stale && <div className="artifact-stale-notice">源文件已变更，请重新生成或分析此文档。</div>}
          <div className="doc-summary msg-bubble"><ChatMarkdown>{normalizeDocumentSummary(doc.summary)}</ChatMarkdown></div>
          {doc.timestamp > 0 && <div className="doc-time">{new Date(doc.timestamp).toLocaleString("zh-CN")}</div>}
        </div>
      ))}
    </div>
  )
}

function ArtifactToolbar({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  return (
    <div className="artifact-toolbar">
      <span>会话资料自动同步</span>
      <button className="artifact-refresh-button" onClick={() => void onRefresh()} title="从服务端重新同步">
        <RefreshCwIcon size={13} /> 刷新
      </button>
    </div>
  )
}

function Meta({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="schematic-meta-row"><span className="kv-key">{label}</span><span className="kv-val" title={title}>{value}</span></div>
}

function EmptyState({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return <div className="right-empty">{icon}<span>{text}</span></div>
}

function fileName(path: string): string { return path.split(/[/\\]/).pop() ?? path }
function documentType(type: string): string {
  return type === "datasheet" ? "数据手册" : type === "manual" ? "参考手册" : type === "reference" ? "参考资料" : "其他"
}

function normalizeDocumentSummary(summary: string): string {
  const content = summary.trim()
  if (!content.includes("```") && (content.startsWith("{") || content.startsWith("["))) {
    return `\`\`\`json\n${content}\n\`\`\``
  }
  return content
}
