import { useState } from "react"
import type { PlanItem } from "../store"
import { ChatMarkdown } from "./ChatMarkdown"
import { CheckCircleIcon, CircleIcon } from "./Icons"

interface Props {
  plan: PlanItem
  onApprove: () => void
  onReject: (reason: string) => void
  onSelect: (index: number, label: string, reason: string) => void
}

export function PlanCard({ plan, onApprove, onReject, onSelect }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [option, setOption] = useState<"approve" | "reject" | number | null>(null)
  const [reason, setReason] = useState("")
  const selectedOption = typeof option === "number" ? plan.options?.[option] : undefined

  const submit = () => {
    if (option === "approve") onApprove()
    else if (option === "reject") onReject(reason || "请修改计划")
    else if (typeof option === "number" && selectedOption) onSelect(option, selectedOption.label, reason)
  }

  return (
    <div className="plan-card">
      <div className="plan-header">
        <span className="plan-label">计划</span>
        <span className="plan-title">{plan.title}</span>
      </div>
      <div className="plan-body" style={{ maxHeight: expanded ? "none" : "200px" }}>
        <ChatMarkdown>{plan.content}</ChatMarkdown>
      </div>
      <div className="plan-footer">
        <button className="plan-toggle" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开计划"}</button>
      </div>

      {plan.status === "showing" && (
        <div className="plan-approval">
          <div className="plan-options">
            {plan.options?.length ? plan.options.map((value, index) => (
              <button key={value.label} className={`plan-option ${option === index ? "selected" : ""}`} onClick={() => setOption(index)}>
                <span className="plan-option-num">{index + 1}</span>
                <span className="plan-option-text"><strong>{value.label}</strong>{value.description && <em>{value.description}</em>}</span>
              </button>
            )) : (
              <>
                <button className={`plan-option ${option === "approve" ? "selected" : ""}`} onClick={() => setOption("approve")}>
                  {option === "approve" ? <CheckCircleIcon size={14} /> : <CircleIcon size={14} />}
                  <span className="plan-option-text"><strong>批准</strong> - 退出计划模式并开始实施</span>
                </button>
                <button className={`plan-option ${option === "reject" ? "selected" : ""}`} onClick={() => setOption("reject")}>
                  {option === "reject" ? <CheckCircleIcon size={14} /> : <CircleIcon size={14} />}
                  <span className="plan-option-text"><strong>修改</strong> - 请说明需要修改的内容</span>
                </button>
              </>
            )}
          </div>
          {(option === "reject" || typeof option === "number") && (
            <div className="plan-reason-input">
              <input
                className="plan-reason-field"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") submit() }}
                placeholder={option === "reject" ? "输入修改意见..." : "补充说明（可选）..."}
                autoFocus={option === "reject"}
              />
            </div>
          )}
          <div className="plan-actions">
            <button className="plan-dismiss" onClick={() => { setOption(null); setReason("") }}>忽略</button>
            <button className="plan-submit" disabled={option === null} onClick={submit}>提交</button>
          </div>
        </div>
      )}

      {plan.status === "approved" && <div className="plan-footer"><span className="plan-approved-badge"><CheckCircleIcon size={12} />已批准，正在执行</span></div>}
      {plan.status === "rejected" && <div className="plan-footer"><span className="plan-rejected-badge">已拒绝</span></div>}
    </div>
  )
}
