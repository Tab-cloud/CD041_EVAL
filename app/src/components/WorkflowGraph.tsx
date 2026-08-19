import {
  AlertCircleIcon, CheckCircleIcon, ClockIcon, HandIcon, SpinnerIcon,
} from "./Icons"
import type { WorkflowNode } from "./workflow-types"

export function WorkflowGraph({ nodes }: { nodes: WorkflowNode[] }) {
  const layers = graphLayers(nodes)
  const ordinal = new Map(nodes.map((node) => [node.id, node.ordinal + 1]))
  return (
    <div className="workflow-graph" role="list" aria-label="工作流依赖图">
      <div className="workflow-graph-layers">
        {layers.map((layer, index) => (
          <div className="workflow-graph-layer" key={index}>
            <span className="workflow-graph-layer-label">{index + 1}</span>
            {layer.map((node) => (
              <div className={`workflow-graph-node ${node.status}`} role="listitem" key={node.id} title={node.title}>
                <div><GraphNodeIcon node={node} /><strong>{node.title}</strong></div>
                <span>{publicNodeStatus(node.status)}</span>
                {node.dependsOn.length > 0 && <small>← {node.dependsOn.map((id) => ordinal.get(id) ?? "?").join(", ")}</small>}
                {node.condition && <small className="condition">if #{ordinal.get(node.condition.nodeId) ?? "?"} {conditionLabel(node.condition.operator)} “{node.condition.value}”</small>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function publicNodeStatus(status: WorkflowNode["status"]): string {
  return ({
    pending: "待处理", queued: "准备中", running: "处理中", completed: "已完成",
    failed: "需要处理", skipped: "已跳过", "waiting-human": "等待确认",
    paused: "已暂停", cancelled: "已取消",
  })[status]
}

function conditionLabel(operator: NonNullable<WorkflowNode["condition"]>["operator"]): string {
  return ({ contains: "包含", "not-contains": "不包含", equals: "等于" })[operator]
}

export function graphLayers(nodes: WorkflowNode[]): WorkflowNode[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depths = new Map<string, number>()
  const depthOf = (id: string, visiting = new Set<string>()): number => {
    if (depths.has(id)) return depths.get(id)!
    if (visiting.has(id)) return 0
    const node = byId.get(id)
    if (!node || node.dependsOn.length === 0) { depths.set(id, 0); return 0 }
    const next = new Set(visiting).add(id)
    const depth = 1 + Math.max(...node.dependsOn.map((dependency) => depthOf(dependency, next)))
    depths.set(id, depth)
    return depth
  }
  const layers: WorkflowNode[][] = []
  for (const node of nodes) {
    const depth = depthOf(node.id)
    ;(layers[depth] ??= []).push(node)
  }
  return layers.map((layer) => layer.sort((left, right) => left.ordinal - right.ordinal))
}

function GraphNodeIcon({ node }: { node: WorkflowNode }) {
  if (["running", "queued"].includes(node.status)) return <SpinnerIcon size={11} className="spin" />
  if (node.status === "completed") return <CheckCircleIcon size={11} />
  if (node.status === "failed") return <AlertCircleIcon size={11} />
  if (node.status === "waiting-human") return <HandIcon size={11} />
  return <ClockIcon size={11} />
}
