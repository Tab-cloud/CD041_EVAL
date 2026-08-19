import { useEffect, useRef, useState } from "react"
import { canSubmitChat } from "../chat-submit"
import type { ModelConfig } from "../types"
import { buildModelOptions, resolveModelOptionValue } from "../model-options"
import { useI18n } from "../i18n"
import type { EffortMode, ScopeMode } from "./chat-helpers"
import { EFFORT_OPTIONS, SCOPE_OPTIONS } from "./chat-helpers"
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ListChecksIcon,
  MessageSquareIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
} from "./Icons"

interface ChatInputToolbarProps {
  hasText: boolean
  attachmentCount: number
  isStreaming?: boolean
  onSend: () => void
  onGuide: () => void
  onAbort?: () => void
  onAddAttachment: () => void
  modelConfigs: ModelConfig[]
  activeModelId: string
  onSwitchModel: (id: string) => void
  modelOpen: boolean
  setModelOpen: (value: boolean) => void
  modelRef: React.RefObject<HTMLDivElement | null>
  scope: ScopeMode
  setScope: (scope: ScopeMode) => void
  scopeOpen: boolean
  setScopeOpen: (value: boolean) => void
  scopeRef: React.RefObject<HTMLDivElement | null>
  effort: EffortMode
  setEffort: (effort: EffortMode) => void
}

export function ChatInputToolbar({
  hasText,
  attachmentCount,
  isStreaming,
  onSend,
  onGuide,
  onAbort,
  onAddAttachment,
  modelConfigs,
  activeModelId,
  onSwitchModel,
  modelOpen,
  setModelOpen,
  modelRef,
  scope,
  setScope,
  scopeOpen,
  setScopeOpen,
  scopeRef,
  effort,
  setEffort,
}: ChatInputToolbarProps) {
  const { t } = useI18n()
  const [effortOpen, setEffortOpen] = useState(false)
  const effortRef = useRef<HTMLDivElement>(null)
  const modelOptions = [
    {
      id: "auto",
      name: t("chat.autoRoute"),
      provider: "system",
      concreteId: "auto",
      configId: "system",
      variantId: "auto",
      label: t("chat.autoRoute"),
    },
    ...buildModelOptions(modelConfigs),
  ]
  const selectedModelId = resolveModelOptionValue(modelOptions, activeModelId) || "auto"
  const currentOption = modelOptions.find((option) => option.id === selectedModelId) ?? modelOptions[0]
  const scopeText = (id: ScopeMode) => id === "confirm-changes"
    ? { label: t("chat.scope.confirm.label"), desc: t("chat.scope.confirm.desc") }
    : id === "auto-edit"
      ? { label: t("chat.scope.auto.label"), desc: t("chat.scope.auto.desc") }
      : id === "plan-mode"
        ? { label: t("chat.scope.plan.label"), desc: t("chat.scope.plan.desc") }
        : { label: t("chat.scope.full.label"), desc: t("chat.scope.full.desc") }

  useEffect(() => {
    if (!effortOpen) return
    const onClick = (event: MouseEvent) => {
      if (effortRef.current && !effortRef.current.contains(event.target as Node)) {
        setEffortOpen(false)
      }
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [effortOpen])

  return (
    <div className="input-toolbar">
      <button type="button" className="tb-btn" onClick={onAddAttachment} title={t("chat.addFile")}>
        <PlusIcon size={14} />
      </button>
      <div className="tb-scope-wrap" ref={scopeRef}>
        <div
          className={`tb-scope${scope === "full-access" ? " warn" : ""}`}
          onClick={() => setScopeOpen(!scopeOpen)}
          title={t("chat.scope")}
        >
          <span className="tb-scope-icon">{SCOPE_OPTIONS.find((option) => option.id === scope)?.icon}</span>
          <span className="tb-scope-text">{scopeText(scope).label}</span>
          <span className="tb-scope-caret"><ChevronDownIcon size={10} /></span>
        </div>
        {scopeOpen && (
          <div className="tb-scope-dropdown">
            {SCOPE_OPTIONS.map((option) => (
              <button
                key={option.id}
                className={`tb-scope-option ${option.id === scope ? "active" : ""} ${option.warn ? "warn" : ""}`}
                onClick={() => {
                  setScope(option.id)
                  setScopeOpen(false)
                }}
              >
                <span className="tb-scope-opt-icon">{option.icon}</span>
                <div className="tb-scope-opt-text">
                  <div className="tb-scope-opt-label">{scopeText(option.id).label}</div>
                  <div className="tb-scope-opt-desc">{scopeText(option.id).desc}</div>
                </div>
                {option.id === scope && (
                  <span className="tb-scope-opt-check"><CheckIcon size={12} /></span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }} />
      {modelOptions.length > 0 && (
        <div className="tb-model" ref={modelRef}>
          <button
            className="tb-model-btn"
            onClick={() => setModelOpen(!modelOpen)}
            title={currentOption?.id ?? ""}
          >
            <span className="tb-model-dot" />
            <span className="tb-model-name">{currentOption?.name || t("chat.selectModel")}</span>
            <span className="tb-model-caret"><ChevronDownIcon size={10} /></span>
          </button>
          {modelOpen && (
            <div className="tb-model-dropdown">
              {modelOptions.map((option) => (
                <button
                  key={option.id}
                  className={`tb-model-option ${option.id === selectedModelId ? "active" : ""}`}
                  onClick={() => {
                    onSwitchModel(option.id)
                    setModelOpen(false)
                  }}
                >
                  <span className="tb-model-opt-name">{option.name}</span>
                  <span className="tb-model-opt-id">{option.concreteId}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="tb-effort-wrap" ref={effortRef}>
        <div
          className="tb-effort"
          onClick={() => setEffortOpen(!effortOpen)}
          title={t("chat.thinking")}
        >
          <BrainIcon size={13} />
          <span className="tb-effort-label">
            {effort === "on" ? t("chat.effort.on") : t("chat.effort.off")}
          </span>
          <span className="tb-effort-caret"><ChevronDownIcon size={10} /></span>
        </div>
        {effortOpen && (
          <div className="tb-effort-dropdown">
            {EFFORT_OPTIONS.map((option) => (
              <button
                key={option.id}
                className={`tb-effort-option ${option.id === effort ? "active" : ""}`}
                onClick={() => {
                  setEffort(option.id)
                  setEffortOpen(false)
                }}
              >
                <span className="tb-effort-opt-label">
                  {option.id === "on" ? t("chat.effort.on") : t("chat.effort.off")}
                </span>
                {option.id === effort && (
                  <span className="tb-effort-opt-check"><CheckIcon size={12} /></span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {isStreaming ? (
        <>
          <button
            className="tb-guide-send"
            onClick={onGuide}
            disabled={!canSubmitChat(hasText, attachmentCount)}
            title="把补充要求加入当前任务（Enter）"
          >
            <MessageSquareIcon size={14} />
            <span>引导</span>
          </button>
          <button
            className="tb-queue-send"
            onClick={onSend}
            disabled={!canSubmitChat(hasText, attachmentCount)}
            title="等当前任务完成后再执行"
          >
            <ListChecksIcon size={14} />
            <span>排队</span>
          </button>
          <button className="tb-stop" onClick={onAbort} title={t("chat.stopOutput")}>
            <StopIcon size={14} />
            <span className="tb-stop-label">{t("common.stop")}</span>
            <span className="tb-stop-esc">Esc</span>
          </button>
        </>
      ) : (
        <button className="tb-send" onClick={onSend} disabled={!canSubmitChat(hasText, attachmentCount)} title={t("chat.send")}>
          <SendIcon size={16} />
        </button>
      )}
    </div>
  )
}
