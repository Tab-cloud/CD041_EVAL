import { useEffect, useRef, type KeyboardEvent } from "react"
import { SendIcon, XIcon } from "./Icons"

interface Props {
  value: string
  attachmentCount: number
  submitting: boolean
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}

export function UserMessageEditor(props: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      props.onCancel()
      return
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault()
      props.onSubmit()
    }
  }

  return (
    <div className="user-msg-editor" onClick={(event) => event.stopPropagation()}>
      <textarea
        ref={inputRef}
        value={props.value}
        aria-label="编辑历史消息"
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <p className="user-msg-editor-note">
        重新发送后，此消息及之后的旧回复会被新内容替换。
        {props.attachmentCount > 0 && " 历史附件不会自动重复提交；如仍需附件，请取消并在输入框中重新添加。"}
      </p>
      <div className="user-msg-editor-actions">
        <button type="button" className="user-msg-edit-cancel" onClick={props.onCancel} disabled={props.submitting}>
          <XIcon size={12} />取消
        </button>
        <button type="button" className="user-msg-edit-submit" onClick={props.onSubmit} disabled={!props.value.trim() || props.submitting}>
          <SendIcon size={12} />{props.submitting ? "正在发送" : "重新发送"}
        </button>
      </div>
    </div>
  )
}
