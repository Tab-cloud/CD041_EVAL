import { useState, type Ref } from "react"
import type { ToolApproval } from "../store"
import { CheckIcon, ShieldIcon, XIcon } from "./Icons"

interface Props {
  approval: ToolApproval
  onDecision: (decision: ApprovalDecision) => Promise<void>
  cardRef?: Ref<HTMLElement>
}

export type ApprovalDecision = "deny" | "allow-once" | "allow-all"

export function ToolApprovalCard({ approval, onDecision, cardRef }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const decide = async (decision: ApprovalDecision) => {
    setSubmitting(true)
    setError("")
    try {
      await onDecision(decision)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setSubmitting(false)
    }
  }

  return (
    <section
      ref={cardRef}
      className="tool-approval-card"
      role="alertdialog"
      aria-labelledby={`approval-title-${approval.id}`}
      aria-describedby={`approval-reason-${approval.id}`}
      tabIndex={-1}
    >
      <div className="tool-approval-heading">
        <span className="tool-approval-icon"><ShieldIcon size={15} /></span>
        <div>
          <strong id={`approval-title-${approval.id}`}>等待确认</strong>
          <span>{approval.toolName}</span>
        </div>
      </div>
      <p id={`approval-reason-${approval.id}`}>{approval.reason}</p>
      <div className="tool-approval-target">
        <code>{approval.target}</code>
      </div>
      {error && <div className="tool-approval-error">{error}</div>}
      <div className="tool-approval-actions">
        <button className="btn btn-ghost" disabled={submitting} onClick={() => void decide("deny")}>
          <XIcon size={13} />拒绝
        </button>
        <button className="btn btn-secondary" disabled={submitting} onClick={() => void decide("allow-once")}>
          <CheckIcon size={13} />{submitting ? "提交中..." : "允许本次"}
        </button>
        <button className="btn btn-primary" disabled={submitting} onClick={() => void decide("allow-all")}>
          <ShieldIcon size={13} />{submitting ? "提交中..." : "允许本会话全部"}
        </button>
      </div>
    </section>
  )
}
