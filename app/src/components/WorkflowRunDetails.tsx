import { useState, type ReactNode } from "react"
import {
  AlertCircleIcon, CheckCircleIcon, FileTextIcon, GitBranchIcon, HandIcon, ListChecksIcon,
  PauseIcon, PlayIcon, RefreshCwIcon, SpinnerIcon, StopIcon, Trash2Icon,
} from "./Icons"
import { WorkflowGraph } from "./WorkflowGraph"
import type { WorkflowNode, WorkflowRun } from "./workflow-types"

interface Props {
  run: WorkflowRun
  busy: string | null
  reportOpen: boolean
  humanResult: Record<string, string>
  onHumanResult: (nodeId: string, value: string) => void
  onAction: (runId: string, action: string, nodeId?: string, result?: string) => Promise<void>
  onReport: () => void
  onDelete: (id: string) => Promise<void>
}

export function WorkflowRunDetails(props: Props) {
  const { run, busy, reportOpen, humanResult, onHumanResult, onAction, onReport, onDelete } = props
  const [view, setView] = useState<"graph" | "list">("graph")
  return (
    <div className="workflow-run-body">
      <div className="workflow-run-actions">
        <button className={`icon-action-btn ${view === "graph" ? "active" : ""}`} title="依赖图" onClick={() => setView("graph")}><GitBranchIcon size={12} /></button>
        <button className={`icon-action-btn ${view === "list" ? "active" : ""}`} title="节点列表" onClick={() => setView("list")}><ListChecksIcon size={12} /></button>
        <span />
        <RunActions run={run} busy={busy} onAction={onAction} onReport={onReport} onDelete={onDelete} />
      </div>
      {view === "graph" ? <WorkflowGraph nodes={run.nodes} /> : (
        <div className="workflow-node-list">
          {run.nodes.map((node) => <WorkflowNodeRow key={node.id} run={run} node={node} busy={busy}
            humanResult={humanResult[node.id] ?? ""} onHumanResult={(value) => onHumanResult(node.id, value)} onAction={onAction} />)}
        </div>
      )}
      {reportOpen && <pre className="workflow-report">{run.report || "报告将在节点执行后生成。"}</pre>}
    </div>
  )
}

function RunActions({ run, busy, onAction, onReport, onDelete }: {
  run: WorkflowRun; busy: string | null
  onAction: (id: string, action: string) => Promise<void>; onReport: () => void; onDelete: (id: string) => Promise<void>
}) {
  const locked = busy !== null
  return <>
    {run.status === "planned" && <IconButton title="开始" disabled={locked} onClick={() => void onAction(run.id, "start")}><PlayIcon size={12} /></IconButton>}
    {run.status === "running" && <IconButton title="节点完成后暂停" disabled={locked} onClick={() => void onAction(run.id, "pause")}><PauseIcon size={12} /></IconButton>}
    {run.status === "pausing" && <SpinnerIcon size={12} className="spin" />}
    {run.status === "paused" && <IconButton title="继续" disabled={locked} onClick={() => void onAction(run.id, "resume")}><PlayIcon size={12} /></IconButton>}
    {["running", "pausing", "paused", "failed", "planned"].includes(run.status) && <IconButton title="取消" disabled={locked} onClick={() => void onAction(run.id, "cancel")}><StopIcon size={11} /></IconButton>}
    {["completed", "failed", "cancelled"].includes(run.status) && <IconButton title="重放此工作流" disabled={locked} onClick={() => void onAction(run.id, "replay")}><RefreshCwIcon size={11} /></IconButton>}
    <IconButton title="执行报告" disabled={false} onClick={onReport}><FileTextIcon size={12} /></IconButton>
    {["completed", "cancelled"].includes(run.status) && <IconButton title="删除" disabled={locked} onClick={() => void onDelete(run.id)}><Trash2Icon size={12} /></IconButton>}
  </>
}

function WorkflowNodeRow({ run, node, busy, humanResult, onHumanResult, onAction }: {
  run: WorkflowRun; node: WorkflowNode; busy: string | null; humanResult: string
  onHumanResult: (value: string) => void
  onAction: (runId: string, action: string, nodeId?: string, result?: string) => Promise<void>
}) {
  const canTakeOver = ["running", "queued"].includes(node.status)
  const canRetry = ["failed", "cancelled", "paused"].includes(node.status) && !["running", "pausing"].includes(run.status)
  return <div className={`workflow-node ${node.status}`}>
    <div className="workflow-node-line"><NodeIcon node={node} /><span className="workflow-node-name">{node.ordinal + 1}. {node.title}</span><span>{nodeLabel(node.status)}</span>
      {canTakeOver && <IconButton title="人工接管" disabled={busy !== null} onClick={() => void onAction(run.id, "takeover", node.id)}><HandIcon size={11} /></IconButton>}
      {canRetry && <IconButton title="从此节点重试" disabled={busy !== null} onClick={() => void onAction(run.id, "retry-node", node.id)}><RefreshCwIcon size={11} /></IconButton>}
    </div>
    {node.error && <div className="workflow-node-error">{node.error}</div>}
    {node.status === "waiting-human" && <div className="workflow-human-form"><textarea rows={2} value={humanResult} onChange={(event) => onHumanResult(event.target.value)} placeholder="人工处理结果" /><button className="panel-action-btn primary" disabled={!humanResult.trim() || busy !== null} onClick={() => void onAction(run.id, "complete-human", node.id, humanResult)}>提交并继续</button></div>}
  </div>
}

function NodeIcon({ node }: { node: WorkflowNode }) {
  if (["running", "queued"].includes(node.status)) return <SpinnerIcon size={12} className="spin" />
  if (node.status === "completed") return <CheckCircleIcon size={12} />
  if (node.status === "failed") return <AlertCircleIcon size={12} />
  if (node.status === "waiting-human") return <HandIcon size={12} />
  return <span className="workflow-node-dot" />
}

function IconButton({ title, disabled, onClick, children }: { title: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="icon-action-btn" title={title} disabled={disabled} onClick={(event) => { event.stopPropagation(); onClick() }}>{children}</button>
}

function nodeLabel(status: WorkflowNode["status"]): string { return ({ pending: "待执行", queued: "排队", running: "运行", completed: "完成", failed: "失败", skipped: "跳过", "waiting-human": "人工处理", paused: "暂停", cancelled: "取消" })[status] }
