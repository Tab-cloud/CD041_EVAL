import { Fragment, useEffect, useState } from "react"
import type { AssistantPart, ChatMessage } from "../types"
import type { CompactSummary, WorkLogEntry } from "../store"
import { ChatMarkdown, CopyButton, copyToClipboard } from "./ChatMarkdown"
import {
  BrainIcon, ChevronDownIcon, DownloadIcon, FileDocxIcon, FileIcon,
  FileImageIcon, FilePdfIcon, FilePptxIcon, FileTextIcon, FileXlsxIcon, RefreshCwIcon,
  ShareIcon, ThumbsDownIcon, ThumbsUpIcon,
} from "./Icons"
import { toolStatusLabel, toolTargetPath } from "./chat-helpers"
import { WorkLogPanel } from "./WorkLogPanel"
import { compactDividerAfterIndex } from "../chat-timeline"
import { formatDeliveredFileSize, openDeliveredFile } from "../delivered-files"
import { visibleReasoningParts } from "../chat-message-parts"
import { normalizeHistoricalResubmission } from "../chat-submit"
import { conversationBranchTarget } from "../conversation-branch"
import { UserMessage } from "./UserMessage"

interface Props {
  messages: ChatMessage[]
  workspace: string | null
  isStreaming: boolean
  streamStartedAt: number | null
  elapsed: number
  isCompacting: boolean
  toolStatus: { name: string; input?: Record<string, unknown> } | null
  agentProgress: { phase: "queued" | "model" | "tools" | "repair" | "finalization"; step: number; maxSteps: number; toolCount?: number } | null
  workLog: WorkLogEntry[]
  connectionStatus: "connected" | "disconnected" | "connecting"
  reconnectAttempt: number
  compactSummary: CompactSummary | null
  onRegenerate?: (messageIndex: number) => void
  canEditHistory: boolean
  onResubmit?: (source: ChatMessage, content: string) => boolean | Promise<boolean>
}

export function ChatMessages(props: Props) {
  const compactAfterIndex = compactDividerAfterIndex(props.messages, props.compactSummary)
  const [editingUserKey, setEditingUserKey] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")
  const [resubmitting, setResubmitting] = useState(false)

  useEffect(() => {
    if (props.canEditHistory || resubmitting) return
    setEditingUserKey(null)
    setEditDraft("")
  }, [props.canEditHistory, resubmitting])

  const beginEdit = (key: string, content: string) => {
    if (resubmitting || !props.canEditHistory) return
    setEditingUserKey(key)
    setEditDraft(content)
  }

  const cancelEdit = () => {
    if (resubmitting) return
    setEditingUserKey(null)
    setEditDraft("")
  }

  const resubmit = async (key: string, source: ChatMessage) => {
    const content = normalizeHistoricalResubmission(editDraft)
    if (!content || !props.onResubmit || !props.canEditHistory) return
    setResubmitting(true)
    try {
      if (await props.onResubmit(source, content)) {
        setEditingUserKey((current) => current === key ? null : current)
        setEditDraft("")
      }
    } finally {
      setResubmitting(false)
    }
  }

  return (
    <>
      {compactAfterIndex === -1 && <CompactDivider />}
      {props.messages.map((message, index) => {
        const messageKey = `${message.requestId ?? message.seq ?? message.timestamp}-${index}`
        const editing = editingUserKey === messageKey
        return (
        <Fragment key={messageKey}>
          <div className={`message ${message.role}`}>
            <div className="msg-body">
              {(message.content || message.attachments?.length || message.deliveryFiles?.length || message.parts?.some((part) => part.state !== "discarded")) && (message.role === "assistant" ? (
                <div className={`msg-bubble ${message.content.startsWith("✓ 上下文已压缩") ? "compact-notice" : ""}`}>
                    <AssistantMessage
                      message={message}
                      workspace={props.workspace}
                      isLast={index === props.messages.length - 1}
                      isStreaming={props.isStreaming}
                      onRegenerate={props.canEditHistory ? () => props.onRegenerate?.(index) : undefined}
                    />
                </div>
              ) : (
                <UserMessage
                  content={message.content}
                  attachments={<Attachments attachments={message.attachments ?? []} />}
                  attachmentCount={message.attachments?.length ?? 0}
                  editable={props.canEditHistory && Boolean(conversationBranchTarget(message))}
                  editing={editing}
                  draft={editDraft}
                  submitting={resubmitting}
                  onBeginEdit={() => beginEdit(messageKey, message.content)}
                  onDraftChange={setEditDraft}
                  onCancel={cancelEdit}
                  onSubmit={() => void resubmit(messageKey, message)}
                />
              ))}
            </div>
          </div>
          {compactAfterIndex === index && <CompactDivider />}
        </Fragment>
      )})}
      {(props.isStreaming || props.workLog.some((entry) => !entry.recovered) || props.connectionStatus === "connecting") && <WorkStatus {...props} />}
    </>
  )
}

function CompactDivider() {
  return (
    <div className="compact-divider" aria-label="上下文在此处压缩">
      <div className="compact-divider-line" />
      <span className="compact-divider-text"><DownloadIcon size={12} />上下文已压缩</span>
      <div className="compact-divider-line" />
    </div>
  )
}

function AssistantMessage(props: {
  message: ChatMessage
  workspace: string | null
  isLast: boolean
  isStreaming: boolean
  onRegenerate?: () => void
}) {
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null)
  const share = async () => {
    const text = props.message.content
    if (navigator.share) {
      try { await navigator.share({ text }); return } catch { /* 用户取消或宿主不支持时降级复制 */ }
    }
    await copyToClipboard(text)
  }
  return (
    <>
      {visibleReasoningParts(props.message).map((part) => <ReasoningPartView key={part.id} part={part} workspace={props.workspace} />)}
      <ChatMarkdown workspace={props.workspace}>{stripThinkingTags(props.message.content)}</ChatMarkdown>
      <DeliveredFiles files={props.message.deliveryFiles ?? []} />
      {props.message.content && !(props.isLast && props.isStreaming) && (
        <div className="msg-actions">
          <CopyButton text={props.message.content} className="msg-action-btn" />
          <button type="button" className={`msg-action-btn ${feedback === "up" ? "active" : ""}`} title="有帮助" aria-pressed={feedback === "up"} onClick={() => setFeedback(feedback === "up" ? null : "up")}><ThumbsUpIcon size={13} /></button>
          <button type="button" className={`msg-action-btn ${feedback === "down" ? "active" : ""}`} title="没有帮助" aria-pressed={feedback === "down"} onClick={() => setFeedback(feedback === "down" ? null : "down")}><ThumbsDownIcon size={13} /></button>
          <button type="button" className="msg-action-btn" title="分享" onClick={() => void share()}><ShareIcon size={13} /></button>
          {props.onRegenerate && <button type="button" className="msg-action-btn" title="重新执行" onClick={props.onRegenerate}><RefreshCwIcon size={13} /></button>}
          <span className="msg-action-time">{new Date(props.message.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      )}
    </>
  )
}

function ReasoningPartView({ part, workspace }: { part: AssistantPart; workspace: string | null }) {
  const [expanded, setExpanded] = useState(part.state === "streaming")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (part.state !== "streaming") return
    setExpanded(true)
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [part.state])
  const endedAt = part.endedAt ?? now
  const elapsed = Math.max(0, Math.floor((endedAt - part.startedAt) / 1_000))
  return (
    <div className={`msg-thinking-inline ${expanded ? "" : "collapsed"}`}>
      <button type="button" className="msg-thinking-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <BrainIcon size={12} />
        <span className="msg-thinking-label">{part.state === "streaming" ? "思考中" : "已思考"} · {formatDuration(elapsed)}</span>
        <ChevronDownIcon size={10} style={{ marginLeft: "auto", transition: "transform .2s", transform: expanded ? "rotate(180deg)" : "none" }} />
      </button>
      {expanded && part.text.trim() && <div className="msg-thinking-body"><ChatMarkdown workspace={workspace}>{part.text.trim()}</ChatMarkdown></div>}
    </div>
  )
}

function DeliveredFiles({ files }: { files: NonNullable<ChatMessage["deliveryFiles"]> }) {
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (files.length === 0) return null

  const open = async (file: (typeof files)[number]) => {
    setOpening(file.artifactId)
    setError(null)
    try {
      await openDeliveredFile(file)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOpening(null)
    }
  }

  return (
    <section className="delivery-files" aria-label="交付文件">
      <div className="delivery-files-heading">
        <span>交付文件</span>
        <span className="delivery-files-count">{files.length}</span>
      </div>
      <div className="delivery-files-list">
        {files.map((file) => (
          <button
            type="button"
            key={file.artifactId}
            className="delivery-file-row"
            disabled={!file.exists || opening === file.artifactId}
            title={file.exists ? `打开 ${file.path}` : `${file.path} 已不存在`}
            onClick={() => void open(file)}
          >
            <span className={`delivery-file-icon category-${file.category}`}>
              <AttachmentIcon name={file.name} size={18} />
            </span>
            <span className="delivery-file-copy">
              <span className="delivery-file-name">{file.name}</span>
              <span className="delivery-file-meta">
                <span>{file.relativePath}</span>
                <span>{formatDeliveredFileSize(file.size)}</span>
                {!file.exists && <span className="delivery-file-warning">文件不存在</span>}
                {file.exists && file.stale && <span className="delivery-file-warning">交付后已更新</span>}
              </span>
            </span>
            <span className="delivery-file-open">{opening === file.artifactId ? "正在打开" : "打开"}</span>
          </button>
        ))}
      </div>
      {error && <div className="delivery-files-error" role="status">{error}</div>}
    </section>
  )
}

function Attachments({ attachments }: { attachments: NonNullable<ChatMessage["attachments"]> }) {
  if (attachments.length === 0) return null
  return (
    <div className="msg-attachments">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.name}-${index}`} className="msg-att-chip" title={attachment.name}>
          <span className="msg-att-icon"><AttachmentIcon name={attachment.name} /></span>
          <span className="msg-att-name">{attachment.name}</span>
        </span>
      ))}
    </div>
  )
}

function AttachmentIcon({ name, size = 12 }: { name: string; size?: number }) {
  if (/\.(png|jpg|jpeg|gif|svg|bmp|webp)$/i.test(name)) return <FileImageIcon size={size} />
  if (/\.(c|h|cpp|hpp|rs|ts|py|js|jsx|tsx)$/i.test(name)) return <FileTextIcon size={size} />
  if (/\.pdf$/i.test(name)) return <FilePdfIcon size={size} />
  if (/\.docx?$/i.test(name)) return <FileDocxIcon size={size} />
  if (/\.xlsx?$/i.test(name)) return <FileXlsxIcon size={size} />
  if (/\.pptx?$/i.test(name)) return <FilePptxIcon size={size} />
  return <FileIcon size={size} />
}

function WorkStatus(props: Props) {
  const toolTarget = props.toolStatus ? toolTargetPath(props.toolStatus.input) : ""
  const progress = props.agentProgress
  const label = props.isCompacting
    ? "压缩上下文"
    : props.toolStatus
      ? `${toolStatusLabel(props.toolStatus.name)}${toolTarget ? ` · ${toolTarget}` : ""}`
      : progress
          ? progress.phase === "queued"
            ? `${agentProgressLabel(progress)} · ${formatDuration(props.elapsed)}`
            : `${agentProgressLabel(progress)} · 第 ${progress.step}/${progress.maxSteps} 步 · ${formatDuration(props.elapsed)}`
          : `生成回复 · ${formatDuration(props.elapsed)}`
  return (
    <div className="work-status-panel">
      <WorkLogPanel
        entries={props.workLog}
        isStreaming={props.isStreaming}
        activeLabel={label}
        connectionStatus={props.connectionStatus}
        reconnectAttempt={props.reconnectAttempt}
      />
    </div>
  )
}

function agentProgressLabel(progress: NonNullable<Props["agentProgress"]>): string {
  if (progress.phase === "queued") return "等待主 Agent 调度"
  if (progress.phase === "tools") return progress.toolCount ? `执行 ${progress.toolCount} 个工具` : "执行工具"
  if (progress.phase === "repair") return "分析问题并尝试替代方案"
  if (progress.phase === "finalization") return "整理执行结论"
  return "模型处理中"
}

function stripThinkingTags(text: string): string {
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").replace(/<think\b[^>]*>[\s\S]*$/gi, "").trim()
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  return `${hours} 时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`
}
