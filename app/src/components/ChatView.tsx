import { useState, useRef, useEffect, type KeyboardEvent } from "react"
import type { ChatMessage, ModelConfig } from "../types"
import type { CompactSummary, WorkLogEntry, PlanItem, QueuedInstruction, ToolApproval, UserQuestion } from "../store"
import type { Attachment, ScopeMode, EffortMode } from "./chat-helpers"
import { fmtSize } from "./chat-helpers"
import { ChatInput } from "./ChatInput"
import { ChatMessages } from "./ChatMessages"
import { PlanCard } from "./PlanCard"
import { ToolApprovalCard } from "./ToolApprovalCard"
import type { ApprovalDecision } from "./ToolApprovalCard"
import { UserQuestionDialog } from "./UserQuestionDialog"
import { InstructionQueue } from "./InstructionQueue"
import { useChatAttachments } from "../hooks/useChatAttachments"
import { shouldClearChatComposer } from "../chat-submit"
interface ChatViewProps {
  messages: ChatMessage[]
  isStreaming: boolean
  activeAgentId: string
  modelConfigs: ModelConfig[]
  activeModelId: string
  workspace: string | null
  defaultScope: ScopeMode
  defaultEffort: EffortMode
  streamStartedAt: number | null
  isCompacting: boolean
  toolStatus: { name: string; input?: Record<string, unknown> } | null
  agentProgress: { phase: "queued" | "model" | "tools" | "repair" | "finalization"; step: number; maxSteps: number; toolCount?: number } | null
  workLog: WorkLogEntry[]
  connectionStatus: "connected" | "disconnected" | "connecting"
  reconnectAttempt: number
  compactSummary: CompactSummary | null
  plan: PlanItem | null
  pendingApprovals: ToolApproval[]
  pendingQuestions: UserQuestion[]
  currentInstruction?: QueuedInstruction
  queuedInstructions: QueuedInstruction[]
  onPlanApprove: () => void
  onPlanReject: (reason: string) => void
  onPlanSelect: (index: number, label: string, reason: string) => void
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => Promise<void>
  onQuestionAnswer: (questionId: string, answer: string) => Promise<void>
  onQuestionCancel: (questionId: string) => Promise<void>
  onRemoveQueuedInstruction: (instructionId: string) => void
  onScopeChange?: (scope: ScopeMode) => void
  onEffortChange?: (effort: EffortMode) => void
  onSend: (text: string, attachments: Attachment[], scope: string, effort: string) => false | void | Promise<false | void>
  onResubmit: (source: ChatMessage, content: string, scope: string, effort: string) => false | void | Promise<false | void>
  onGuide: (text: string, attachments: Attachment[]) => false | void | Promise<false | void>
  onSwitchModel: (modelId: string) => void
  onAbort?: () => void
}
export function ChatView({ messages, isStreaming, onSend, onResubmit, onGuide, modelConfigs, activeModelId, onSwitchModel, workspace, defaultScope, defaultEffort, streamStartedAt, isCompacting, toolStatus, agentProgress, workLog, connectionStatus, reconnectAttempt, compactSummary, plan, pendingApprovals, pendingQuestions, currentInstruction, queuedInstructions, onPlanApprove, onPlanReject, onPlanSelect, onApprovalDecision, onQuestionAnswer, onQuestionCancel, onRemoveQueuedInstruction, onScopeChange, onEffortChange, onAbort }: ChatViewProps) {
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [effort, setEffort] = useState<EffortMode>(defaultEffort)
  const [elapsed, setElapsed] = useState(0)
  const [sentHistory, setSentHistory] = useState<string[]>([])
  const [modelOpen, setModelOpen] = useState(false)
  const [scope, setScope] = useState<ScopeMode>(defaultScope)
  const [scopeOpen, setScopeOpen] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const approvalRef = useRef<HTMLElement>(null)
  const prevMsgCount = useRef(0)
  const lastFocusedApprovalId = useRef<string | null>(null)
  useEffect(() => setScope(defaultScope), [defaultScope])
  useEffect(() => setEffort(defaultEffort), [defaultEffort])
  // 自动滚动：消息数量变化（新会话/新消息）→ 强制滚到底；流式增量 → 仅在底部附近才滚
  useEffect(() => {
    const el = chatMessagesRef.current
    if (!el) return
    const countChanged = messages.length !== prevMsgCount.current
    prevMsgCount.current = messages.length
    if (countChanged) {
      // 消息数量变化（加载历史会话 / 发送新消息）→ 直接跳到底部
      bottomRef.current?.scrollIntoView({ behavior: "auto" })
    } else {
      // 流式增量更新 → 仅在底部附近才跟随滚动
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      if (isNearBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages, pendingApprovals])
  // 审批是阻塞运行的高优先级交互：即使用户正在浏览历史，也必须立即带到视野中。
  useEffect(() => {
    const pendingApproval = pendingApprovals[0]
    if (!pendingApproval || lastFocusedApprovalId.current === pendingApproval.id) return
    lastFocusedApprovalId.current = pendingApproval.id
    const frame = requestAnimationFrame(() => {
      approvalRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
      approvalRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingApprovals])
  // 点击外部关闭 model 下拉
  useEffect(() => {
    if (!modelOpen) return
    const onClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [modelOpen])
  // 点击外部关闭 scope 下拉
  useEffect(() => {
    if (!scopeOpen) return
    const onClick = (e: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) setScopeOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [scopeOpen])
  // ─── 工作耗时计时器 ───
  useEffect(() => {
    // streamStartedAt 变化（新消息发送）→ 重置 elapsed
    setElapsed(0)
    if (!isStreaming || !streamStartedAt) return
    // 流式传输中 → 计时
    const tick = () => setElapsed(Math.floor((Date.now() - streamStartedAt) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [isStreaming, streamStartedAt])
  // ─── 消息发送 ───
  const submitComposer = async (mode: "queue" | "guide") => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    const accepted = trimmed === "/clear"
      ? await onSend(trimmed, [], scope, effort)
      : mode === "guide"
      ? await onGuide(trimmed, attachments)
      : await onSend(trimmed, attachments, scope, effort)
    if (!shouldClearChatComposer(accepted)) return
    // 收集发送历史（去重，最多保留 50 条）
    setSentHistory((h) => [trimmed, ...h.filter(t => t !== trimmed)].slice(0, 50))
    setText("")
    setAttachments([])
    textareaRef.current?.focus()
  }
  const handleSend = () => submitComposer("queue")
  const handleGuide = () => submitComposer("guide")
  const executeSlashCommand = async (command: string) => {
    const accepted = await onSend(command, [], scope, effort)
    if (!shouldClearChatComposer(accepted)) return
    setSentHistory((history) => [command, ...history.filter((item) => item !== command)].slice(0, 50))
    setText("")
    setAttachments([])
    textareaRef.current?.focus()
  }
  const resubmitHistoricalMessage = async (source: ChatMessage, content: string) => {
    const accepted = await onResubmit(source, content, scope, effort)
    if (!shouldClearChatComposer(accepted)) return false
    setSentHistory((history) => [content, ...history.filter((item) => item !== content)].slice(0, 50))
    return true
  }
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void (isStreaming ? handleGuide() : handleSend())
    }
  }
  useEffect(() => {
    const el = textareaRef.current
    if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 120) + "px" }
  }, [text])
  const {
    addAttachment: handleAddAttachment,
    removeAttachment,
    handlePaste,
    attachmentError,
    clearAttachmentError,
  } = useChatAttachments(workspace, attachments, setAttachments)
  const input = (
    <ChatInput
      text={text} setText={setText} textareaRef={textareaRef}
      onSend={handleSend} onGuide={handleGuide} onExecuteSlashCommand={(command) => void executeSlashCommand(command)}
      onKeyDown={handleKeyDown} onPaste={handlePaste}
      isStreaming={isStreaming} onAbort={onAbort}
      modelConfigs={modelConfigs} activeModelId={activeModelId} onSwitchModel={onSwitchModel}
      attachments={attachments} onAddAttachment={handleAddAttachment} onRemoveAttachment={removeAttachment}
      attachmentError={attachmentError} onDismissAttachmentError={clearAttachmentError}
      modelOpen={modelOpen} setModelOpen={setModelOpen} modelRef={modelRef}
      scope={scope} setScope={(nextScope) => { setScope(nextScope); onScopeChange?.(nextScope) }} scopeOpen={scopeOpen} setScopeOpen={setScopeOpen}
      scopeRef={scopeRef} fmtSize={fmtSize}
      effort={effort} setEffort={(nextEffort) => { setEffort(nextEffort); onEffortChange?.(nextEffort) }} sentHistory={sentHistory}
    />
  )
  const queue = <InstructionQueue current={currentInstruction} instructions={queuedInstructions} onRemove={onRemoveQueuedInstruction} />
  const questionDialog = pendingQuestions[0] ? (
    <UserQuestionDialog
      key={pendingQuestions[0].id}
      question={pendingQuestions[0]}
      queueLength={pendingQuestions.length}
      onAnswer={(answer) => onQuestionAnswer(pendingQuestions[0]!.id, answer)}
      onCancel={() => onQuestionCancel(pendingQuestions[0]!.id)}
    />
  ) : null
  const canEditHistory = !isStreaming
    && !currentInstruction
    && queuedInstructions.length === 0
    && pendingApprovals.length === 0
    && pendingQuestions.length === 0
  if (messages.length === 0) {
    return (
      <div className="chat-container">
        {questionDialog}
        <div className="chat-messages"><div className="chat-empty"><div className="chat-empty-title">Eval</div></div></div>
        {queue}
        {input}
      </div>
    )
  }
  return (
    <div className="chat-container">
      {questionDialog}
      <div className="chat-messages" ref={chatMessagesRef}>
        <ChatMessages
          messages={messages}
          workspace={workspace}
          isStreaming={isStreaming}
          streamStartedAt={streamStartedAt}
          elapsed={elapsed}
          isCompacting={isCompacting}
          toolStatus={toolStatus}
          agentProgress={agentProgress}
          workLog={workLog}
          connectionStatus={connectionStatus}
          reconnectAttempt={reconnectAttempt}
          compactSummary={compactSummary}
          canEditHistory={canEditHistory}
          onResubmit={resubmitHistoricalMessage}
          onRegenerate={(messageIndex) => {
            if (!canEditHistory) return
            const source = messages.slice(0, messageIndex).reverse().find((message) => message.role === "user")
            if (source?.content) void resubmitHistoricalMessage(source, source.content)
          }}
        />
        {plan && !isStreaming && (
          <PlanCard plan={plan} onApprove={onPlanApprove} onReject={onPlanReject} onSelect={onPlanSelect} />
        )}
        {pendingApprovals.map((approval, index) => <ToolApprovalCard key={approval.id} cardRef={index === 0 ? approvalRef : undefined} approval={approval} onDecision={async (decision) => {
          await onApprovalDecision(approval.id, decision)
          if (decision === "allow-all") {
            setScope("full-access")
            onScopeChange?.("full-access")
          }
        }} />)}
        <div ref={bottomRef} />
      </div>
      {queue}
      {input}
    </div>
  )
}
