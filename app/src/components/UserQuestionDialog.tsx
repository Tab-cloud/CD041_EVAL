import { useEffect, useRef, useState } from "react"
import type { UserQuestion } from "../store"
import { CheckIcon, MessageSquareIcon, XIcon } from "./Icons"

interface Props {
  question: UserQuestion
  queueLength: number
  onAnswer: (answer: string) => Promise<void>
  onCancel: () => Promise<void>
}

export function UserQuestionDialog({ question, queueLength, onAnswer, onCancel }: Props) {
  const [selected, setSelected] = useState("")
  const [custom, setCustom] = useState("")
  const customAllowed = question.allowCustom
  const [customMode, setCustomMode] = useState(customAllowed && question.options.length === 0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const dialogRef = useRef<HTMLElement>(null)
  const answer = customMode ? custom.trim() : selected
  const hasCustomOption = question.options.some(isCustomOption)

  useEffect(() => { dialogRef.current?.focus() }, [])

  const submit = async () => {
    if (!answer) return
    setSubmitting(true)
    setError("")
    try {
      await onAnswer(answer)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setSubmitting(false)
    }
  }

  const cancel = async () => {
    setSubmitting(true)
    setError("")
    try {
      await onCancel()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setSubmitting(false)
    }
  }

  return (
    <div className="user-question-overlay" role="presentation">
      <section
        ref={dialogRef}
        className="user-question-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`question-title-${question.id}`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !submitting) {
            event.preventDefault()
            void cancel()
          }
        }}
      >
        <header className="user-question-header">
          <span className="user-question-icon"><MessageSquareIcon size={17} /></span>
          <div>
            <strong>需要你的选择</strong>
            <span>回答后将继续当前任务{queueLength > 1 ? ` · 还有 ${queueLength - 1} 个问题` : ""}</span>
          </div>
        </header>
        <p id={`question-title-${question.id}`} className="user-question-prompt">{question.question}</p>
        {question.options.length > 0 && (
          <div className="user-question-options" role="radiogroup" aria-label="可选答案">
            {question.options.map((option, index) => (
              <button
                key={`${index}:${option}`}
                type="button"
                role="radio"
                aria-checked={isCustomOption(option) ? customMode : !customMode && selected === option}
                className={`user-question-option ${(isCustomOption(option) ? customMode : !customMode && selected === option) ? "selected" : ""}`}
                disabled={submitting}
                onClick={() => {
                  if (isCustomOption(option)) {
                    setSelected("")
                    setCustomMode(true)
                  } else {
                    setSelected(option)
                    setCustomMode(false)
                  }
                }}
              >
                <span>{index + 1}</span>{option}
              </button>
            ))}
            {customAllowed && !hasCustomOption && (
              <button
                type="button"
                role="radio"
                aria-checked={customMode}
                className={`user-question-option ${customMode ? "selected" : ""}`}
                disabled={submitting}
                onClick={() => setCustomMode(true)}
              >
                <span>+</span>自定义回答
              </button>
            )}
          </div>
        )}
        {customAllowed && customMode && (
          <textarea
            className="user-question-custom"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="请输入你的回答"
            rows={3}
            autoFocus
            disabled={submitting}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void submit()
            }}
          />
        )}
        {error && <div className="user-question-error">{error}</div>}
        <footer className="user-question-actions">
          <span>任务正在安全等待；取消后不会执行本次操作</span>
          <div>
            <button className="btn btn-ghost" disabled={submitting} onClick={() => void cancel()}>
              <XIcon size={13} />取消
            </button>
            <button className="btn btn-primary" disabled={!answer || submitting} onClick={() => void submit()}>
              <CheckIcon size={13} />{submitting ? "处理中..." : "确认并继续"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function isCustomOption(option: string): boolean {
  return /(?:其他|其它|自定义|other)/i.test(option)
}
