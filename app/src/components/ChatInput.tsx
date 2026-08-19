import { useState, useRef, useEffect, useMemo, type KeyboardEvent } from "react"
import type { ModelConfig } from "../types"
import type { Attachment, ScopeMode, EffortMode, SlashCommand } from "./chat-helpers"
import { SLASH_COMMANDS } from "./chat-helpers"
import { FileImageIcon, FileTextIcon, FilePdfIcon, FileDocxIcon, FileXlsxIcon, FilePptxIcon, FileIcon, XIcon } from "./Icons"
import { ChatInputToolbar } from "./ChatInputToolbar"
import { useI18n } from "../i18n"
import { selectSlashCommand } from "../chat-submit"
interface ChatInputProps {
  text: string; setText: (t: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onSend: () => void; onGuide: () => void; onExecuteSlashCommand: (command: string) => void
  onKeyDown: (e: KeyboardEvent) => void; onPaste?: (e: React.ClipboardEvent) => void
  isStreaming?: boolean; onAbort?: () => void
  modelConfigs: ModelConfig[]; activeModelId: string; onSwitchModel: (id: string) => void
  attachments: Attachment[]; onAddAttachment: () => void; onRemoveAttachment: (i: number) => void
  attachmentError?: string | null; onDismissAttachmentError?: () => void
  modelOpen: boolean; setModelOpen: (v: boolean) => void; modelRef: React.RefObject<HTMLDivElement | null>
  scope: ScopeMode; setScope: (s: ScopeMode) => void
  scopeOpen: boolean; setScopeOpen: (v: boolean) => void; scopeRef: React.RefObject<HTMLDivElement | null>
  fmtSize: (bytes: number) => string
  effort: EffortMode; setEffort: (e: EffortMode) => void
  sentHistory: string[]
}
export function ChatInput({
  text, setText, textareaRef, onSend, onGuide, onExecuteSlashCommand, onKeyDown, onPaste,
  isStreaming, onAbort,
  modelConfigs, activeModelId, onSwitchModel,
  attachments, onAddAttachment, onRemoveAttachment,
  attachmentError, onDismissAttachmentError,
  modelOpen, setModelOpen, modelRef,
  scope, setScope, scopeOpen, setScopeOpen, scopeRef, fmtSize,
  effort, setEffort, sentHistory,
}: ChatInputProps) {
  const { t } = useI18n()
  // 消息发送历史（上下键导航）
  const [historyIdx, setHistoryIdx] = useState(-1)
  const currentTextRef = useRef("") // 保存当前正在编辑的文本，以便从历史中返回
  // ── Slash 命令 ──
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIdx, setSlashIdx] = useState(0)
  const slashRef = useRef<HTMLDivElement>(null)
  const slashFiltered = useMemo<SlashCommand[]>(() => {
    if (!text.startsWith("/")) return []
    const q = text.toLowerCase()
    return SLASH_COMMANDS.filter(c => c.key.toLowerCase().startsWith(q) || q.length <= 1)
  }, [text])
  // 当 text 变化时，自动打开/关闭 slash 下拉并重置选中
  useEffect(() => {
    if (text.startsWith("/") && text.length > 0 && !text.includes(" ") && slashFiltered.length > 0) {
      setSlashOpen(true)
      setSlashIdx(0)
    } else {
      setSlashOpen(false)
    }
  }, [slashFiltered.length, text])
  // 点外部关闭
  useEffect(() => {
    if (!slashOpen) return
    const onDown = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) setSlashOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [slashOpen])
  const applySlash = (cmd: SlashCommand) => {
    const selection = selectSlashCommand(cmd.key)
    setSlashOpen(false)
    if (selection.kind === "execute") {
      onExecuteSlashCommand(selection.command)
      return
    }
    setText(selection.text)
  }
  // 键盘导航（支持 slash 菜单的 Tab/Arrow/Enter + 消息历史 ArrowUp/Down）
  const handleKeyDown = (e: KeyboardEvent) => {
    if (slashOpen && slashFiltered.length > 0) {
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault()
        setSlashIdx((i) => (i + 1) % slashFiltered.length)
        return
      }
      if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault()
        setSlashIdx((i) => (i - 1 + slashFiltered.length) % slashFiltered.length)
        return
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        applySlash(slashFiltered[slashIdx])
        return
      }
      if (e.key === "Escape") {
        setSlashOpen(false)
        return
      }
    }
    // 消息历史导航（slash 未打开且 > 1 条历史时）
    if (!slashOpen && sentHistory.length > 0) {
      if (e.key === "ArrowUp") {
        e.preventDefault()
        if (historyIdx === -1) {
          // 首次按 Up：保存当前正在编辑的文本，从最新历史开始
          currentTextRef.current = text
          setHistoryIdx(0)
          setText(sentHistory[0])
        } else if (historyIdx < sentHistory.length - 1) {
          setHistoryIdx(historyIdx + 1)
          setText(sentHistory[historyIdx + 1])
        }
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        if (historyIdx > 0) {
          setHistoryIdx(historyIdx - 1)
          setText(sentHistory[historyIdx - 1])
        } else if (historyIdx === 0) {
          // 回到最初正在编辑的文本
          setHistoryIdx(-1)
          setText(currentTextRef.current)
          currentTextRef.current = ""
        }
        return
      }
      // 按其他键时重置历史索引
      if (historyIdx >= 0 && e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") {
        setHistoryIdx(-1)
        currentTextRef.current = ""
      }
    }
    // 委托给父级（Send / Shift+Enter 等）
    onKeyDown(e)
  }
  // 键盘导航时自动滚动选中项到可见区域
  useEffect(() => {
    if (!slashOpen || !slashRef.current) return
    const el = slashRef.current.querySelector(".slash-option.active") as HTMLElement | null
    el?.scrollIntoView({ block: "nearest" })
  }, [slashIdx, slashOpen])
  return (
    <div className="chat-input-area">
      <div className="input-card">
        {/* 已选附件（顶部） */}
        {attachments.length > 0 && (
          <div className="input-attachments">
            {attachments.map((a, i) => (
              <div key={i} className="input-att-chip" title={a.path}>
                <span className="att-icon">{
                  (() => {
                    if (/\.(png|jpg|jpeg|gif|svg|bmp|webp)$/i.test(a.name)) return <FileImageIcon size={14} />
                    if (/\.(c|h|cpp|hpp|rs|ts|py|js|jsx|tsx)$/i.test(a.name)) return <FileTextIcon size={14} />
                    if (/\.pdf$/i.test(a.name)) return <FilePdfIcon size={14} />
                    if (/\.docx?$/i.test(a.name)) return <FileDocxIcon size={14} />
                    if (/\.xlsx?$/i.test(a.name)) return <FileXlsxIcon size={14} />
                    if (/\.pptx?$/i.test(a.name)) return <FilePptxIcon size={14} />
                    return <FileIcon size={14} />
                  })()
                }</span>
                <span className="att-name">{a.name}</span>
                <span className="att-size">{fmtSize(a.size)}</span>
                <button className="att-remove" onClick={() => onRemoveAttachment(i)} title={t("common.remove")}><XIcon size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && (
          <div className="input-attachment-error" role="alert">
            <span>{attachmentError}</span>
            <button type="button" onClick={onDismissAttachmentError} title={t("common.close")}>
              <XIcon size={12} />
            </button>
          </div>
        )}
        {/* textarea */}
        <textarea
          ref={textareaRef}
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={handleKeyDown} onPaste={onPaste}
          placeholder={t("chat.placeholder")} rows={1}
        />
        {/* Slash 命令下拉 */}
        {slashOpen && slashFiltered.length > 0 && (
          <div className="slash-dropdown" ref={slashRef}>
            {slashFiltered.map((cmd, i) => (
              <button
                key={cmd.key}
                className={`slash-option ${i === slashIdx ? "active" : ""}`}
                onClick={() => applySlash(cmd)}
                onMouseEnter={() => setSlashIdx(i)}
              >
                <span className="slash-opt-icon">{cmd.icon}</span>
                <div className="slash-opt-text">
                  <span className="slash-opt-label">{cmd.key}</span>
                  <span className="slash-opt-desc">{cmd.desc}</span>
                </div>
                <span className="slash-opt-name">{cmd.label}</span>
              </button>
            ))}
          </div>
        )}
        <ChatInputToolbar
          hasText={Boolean(text.trim())}
          attachmentCount={attachments.length}
          isStreaming={isStreaming}
          onSend={onSend}
          onGuide={onGuide}
          onAbort={onAbort}
          onAddAttachment={onAddAttachment}
          modelConfigs={modelConfigs}
          activeModelId={activeModelId}
          onSwitchModel={onSwitchModel}
          modelOpen={modelOpen}
          setModelOpen={setModelOpen}
          modelRef={modelRef}
          scope={scope}
          setScope={setScope}
          scopeOpen={scopeOpen}
          setScopeOpen={setScopeOpen}
          scopeRef={scopeRef}
          effort={effort}
          setEffort={setEffort}
        />
      </div>
    </div>
  )
}
