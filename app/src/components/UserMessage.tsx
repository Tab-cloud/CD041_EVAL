import type { KeyboardEvent, ReactNode } from "react"
import { copyToClipboard } from "./ChatMarkdown"
import { CopyIcon, PencilIcon } from "./Icons"
import { UserMessageEditor } from "./UserMessageEditor"

interface Props {
  content: string
  attachments: ReactNode
  attachmentCount: number
  editable: boolean
  editing: boolean
  draft: string
  submitting: boolean
  onBeginEdit: () => void
  onDraftChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}

export function UserMessage(props: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!props.editable || props.editing || (event.key !== "Enter" && event.key !== " ")) return
    event.preventDefault()
    props.onBeginEdit()
  }

  return (
    <>
      <div
        className={`msg-bubble user-message-bubble ${props.editing ? "editing" : ""}`}
        role={!props.editing && props.editable ? "button" : undefined}
        tabIndex={!props.editing && props.editable ? 0 : undefined}
        title={!props.editing && props.editable ? "点击编辑并重新发送" : undefined}
        aria-label={!props.editing && props.editable ? "编辑并重新发送此消息" : undefined}
        onClick={() => { if (!props.editing && props.editable) props.onBeginEdit() }}
        onKeyDown={onKeyDown}
      >
        {props.attachments}
        {props.editing ? (
          <UserMessageEditor
            value={props.draft}
            attachmentCount={props.attachmentCount}
            submitting={props.submitting}
            onChange={props.onDraftChange}
            onCancel={props.onCancel}
            onSubmit={props.onSubmit}
          />
        ) : (
          <div className="user-msg-row"><span>{props.content}</span></div>
        )}
      </div>
      {!props.editing && <div className="user-msg-actions">
        {props.editable && <button type="button" className="user-msg-action-btn" title="编辑并重新发送" aria-label="编辑并重新发送消息" onClick={props.onBeginEdit}><PencilIcon size={13} /></button>}
        {props.content && <button type="button" className="user-msg-action-btn" title="复制" aria-label="复制消息" onClick={() => void copyToClipboard(props.content)}><CopyIcon size={13} /></button>}
      </div>}
    </>
  )
}
