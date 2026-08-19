import { useEffect, useRef, useState } from "react"
import { apiFetch } from "../api"
import {
  AlertCircleIcon, CheckIcon, CopyIcon, DownloadIcon, PlusIcon, SaveIcon, SpinnerIcon, Trash2Icon, UploadIcon, XIcon,
} from "./Icons"
import type { WorkflowFailurePolicy, WorkflowTemplate, WorkflowTemplateNodeDefinition } from "./workflow-types"

interface AgentOption { id: string; name: string }
interface Draft { id?: string; name: string; description: string; nodes: WorkflowTemplateNodeDefinition[]; failurePolicy: WorkflowFailurePolicy }
interface Props { templates: WorkflowTemplate[]; onChanged: () => Promise<void> }

export function WorkflowTemplateEditor({ templates, onChanged }: Props) {
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const importInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void apiFetch("/api/agents").then(async (response) => {
      if (!response.ok) throw new Error("Agent 加载失败")
      const values = await response.json() as AgentOption[]
      setAgents(values.map(({ id, name }) => ({ id, name })))
    }).catch((reason) => setError(messageOf(reason)))
  }, [])

  const begin = (template?: WorkflowTemplate) => {
    if (template) {
      setDraft({
        id: template.custom ? template.id : undefined,
        name: template.custom ? template.name : `${template.name}副本`,
        description: template.description,
        nodes: template.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn] })),
        failurePolicy: { ...template.failurePolicy },
      })
    } else {
      const agent = agents[0]
      setDraft({ name: "", description: "", nodes: agent ? [newNode(agent.id, 1)] : [], failurePolicy: { maxRetries: 0, delaySeconds: 0 } })
    }
    setError("")
  }

  const updateNode = (index: number, fields: Partial<WorkflowTemplateNodeDefinition>) => {
    setDraft((current) => current ? {
      ...current,
      nodes: current.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...fields } : node),
    } : current)
  }

  const addNode = () => {
    setDraft((current) => {
      if (!current || agents.length === 0 || current.nodes.length >= 20) return current
      const node = newNode(agents[0]!.id, current.nodes.length + 1)
      if (current.nodes.length > 0) node.dependsOn = [current.nodes[current.nodes.length - 1]!.id]
      return { ...current, nodes: [...current.nodes, node] }
    })
  }

  const removeNode = (index: number) => {
    setDraft((current) => {
      if (!current) return current
      const removedId = current.nodes[index]?.id
      const nodes = current.nodes.filter((_, nodeIndex) => nodeIndex !== index)
        .map((node) => ({
          ...node, dependsOn: node.dependsOn.filter((id) => id !== removedId),
          condition: node.condition?.nodeId === removedId ? undefined : node.condition,
        }))
      return { ...current, nodes }
    })
  }

  const toggleDependency = (nodeIndex: number, dependencyId: string) => {
    setDraft((current) => {
      const node = current?.nodes[nodeIndex]
      if (!current || !node) return current
      const dependsOn = node.dependsOn.includes(dependencyId)
        ? node.dependsOn.filter((id) => id !== dependencyId)
        : [...node.dependsOn, dependencyId]
      const nodes = current.nodes.map((item, index) => index === nodeIndex ? {
        ...item, dependsOn,
        condition: item.condition?.nodeId === dependencyId && !dependsOn.includes(dependencyId) ? undefined : item.condition,
      } : item)
      return { ...current, nodes }
    })
  }

  const setConditionSource = (nodeIndex: number, nodeId: string) => {
    setDraft((current) => {
      const node = current?.nodes[nodeIndex]
      if (!current || !node) return current
      const nodes = current.nodes.map((item, index) => index === nodeIndex ? {
        ...item,
        dependsOn: !nodeId || item.dependsOn.includes(nodeId) ? item.dependsOn : [...item.dependsOn, nodeId],
        condition: nodeId ? { nodeId, operator: item.condition?.operator ?? "contains", value: item.condition?.value ?? "" } : undefined,
      } : item)
      return { ...current, nodes }
    })
  }

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const response = await apiFetch("/api/workflow-templates", {
        method: draft.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "模板保存失败")
      setDraft(null); setError(""); await onChanged()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(false) }
  }

  const removeTemplate = async (id: string) => {
    setBusy(true)
    try {
      const response = await apiFetch(`/api/workflow-templates?id=${encodeURIComponent(id)}`, { method: "DELETE" })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "模板删除失败")
      await onChanged()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(false) }
  }

  const exportTemplate = (template: WorkflowTemplate) => {
    const payload = {
      format: "eval-workflow-template", version: 1,
      template: { name: template.name, description: template.description, nodes: template.nodes, failurePolicy: template.failurePolicy },
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const href = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = href
    link.download = `${safeFileName(template.name)}.eval-workflow.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(href), 1_000)
  }

  const importTemplate = async (file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      if (file.size > 512 * 1_024) throw new Error("模板文件不能超过 512KB")
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>
      const template = parsed.template && typeof parsed.template === "object" ? parsed.template : parsed
      const response = await apiFetch("/api/workflow-templates", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(template),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "模板导入失败")
      setError(""); await onChanged()
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(false); if (importInput.current) importInput.current.value = "" }
  }

  if (draft) return (
    <div className="workflow-template-editor">
      <div className="template-editor-head"><strong>{draft.id ? "编辑模板" : "新建模板"}</strong><button className="icon-action-btn" title="关闭" onClick={() => setDraft(null)}><XIcon size={12} /></button></div>
      {error && <div className="tasks-error"><AlertCircleIcon size={12} />{error}</div>}
      <div className="template-fields">
        <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="模板名称" maxLength={80} />
        <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="模板说明" maxLength={500} />
      </div>
      <div className="template-policy-fields">
        <label>失败重试<select value={draft.failurePolicy.maxRetries} onChange={(event) => setDraft({ ...draft, failurePolicy: { ...draft.failurePolicy, maxRetries: Number(event.target.value) } })}>{[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value} 次</option>)}</select></label>
        <label>重试延迟<input type="number" min={0} max={300} value={draft.failurePolicy.delaySeconds} onChange={(event) => setDraft({ ...draft, failurePolicy: { ...draft.failurePolicy, delaySeconds: Math.max(0, Math.min(300, Number(event.target.value))) } })} /><span>秒</span></label>
      </div>
      <div className="template-node-editor-list">
        {draft.nodes.map((node, index) => (
          <section className="template-node-editor" key={node.id}>
            <div className="template-node-editor-head"><span>{index + 1}</span><input value={node.title} onChange={(event) => updateNode(index, { title: event.target.value })} placeholder="节点名称" /><button className="icon-action-btn" title="删除节点" onClick={() => removeNode(index)}><Trash2Icon size={11} /></button></div>
            <select value={node.agentId} onChange={(event) => updateNode(index, { agentId: event.target.value })} aria-label="执行 Agent">{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
            <textarea rows={2} value={node.prompt} onChange={(event) => updateNode(index, { prompt: event.target.value })} placeholder="节点要求" maxLength={10_000} />
            {index > 0 && <div className="template-dependencies">{draft.nodes.slice(0, index).map((candidate) => <button key={candidate.id} className={node.dependsOn.includes(candidate.id) ? "active" : ""} onClick={() => toggleDependency(index, candidate.id)}>{node.dependsOn.includes(candidate.id) && <CheckIcon size={9} />}{candidate.title || `节点 ${candidate.id}`}</button>)}</div>}
            {index > 0 && <div className="template-condition-row">
              <select aria-label="条件来源" value={node.condition?.nodeId ?? ""} onChange={(event) => setConditionSource(index, event.target.value)}><option value="">始终执行</option>{draft.nodes.slice(0, index).map((candidate) => <option key={candidate.id} value={candidate.id}>当 {candidate.title}</option>)}</select>
              <select aria-label="条件运算" disabled={!node.condition} value={node.condition?.operator ?? "contains"} onChange={(event) => updateNode(index, { condition: node.condition ? { ...node.condition, operator: event.target.value as NonNullable<typeof node.condition>["operator"] } : undefined })}><option value="contains">包含</option><option value="not-contains">不包含</option><option value="equals">等于</option></select>
              <input disabled={!node.condition} value={node.condition?.value ?? ""} onChange={(event) => updateNode(index, { condition: node.condition ? { ...node.condition, value: event.target.value } : undefined })} placeholder="匹配文本" maxLength={500} />
            </div>}
          </section>
        ))}
      </div>
      <div className="template-editor-actions"><button className="panel-action-btn" disabled={draft.nodes.length >= 20} onClick={addNode}><PlusIcon size={11} />节点</button><span /><button className="panel-action-btn" onClick={() => setDraft(null)}>取消</button><button className="panel-action-btn primary" disabled={busy || !draft.name.trim() || draft.nodes.length === 0 || draft.nodes.some((node) => node.condition && !node.condition.value.trim())} onClick={() => void save()}>{busy ? <SpinnerIcon size={11} className="spin" /> : <SaveIcon size={11} />}保存</button></div>
    </div>
  )

  return (
    <div className="workflow-template-list">
      <div className="schedule-toolbar"><span>模板</span><div className="template-toolbar-actions">
        <input ref={importInput} type="file" accept=".json,.eval-workflow.json,application/json" onChange={(event) => void importTemplate(event.target.files?.[0])} />
        <button className="icon-action-btn" title="导入模板" disabled={busy} onClick={() => importInput.current?.click()}><UploadIcon size={12} /></button>
        <button className="icon-action-btn" title="新建模板" disabled={agents.length === 0} onClick={() => begin()}><PlusIcon size={13} /></button>
      </div></div>
      {error && <div className="tasks-error"><AlertCircleIcon size={12} />{error}</div>}
      {templates.map((template) => <div className="workflow-template-row" key={template.id}><div><strong>{template.name}</strong><span>{template.nodes.length} 节点 · {template.description}</span></div><button className="icon-action-btn" title="导出模板" onClick={() => exportTemplate(template)}><DownloadIcon size={11} /></button><button className="icon-action-btn" title={template.custom ? "编辑模板" : "复制为自定义模板"} onClick={() => begin(template)}><CopyIcon size={11} /></button>{template.custom && <button className="icon-action-btn" title="删除模板" disabled={busy} onClick={() => void removeTemplate(template.id)}><Trash2Icon size={11} /></button>}</div>)}
    </div>
  )
}

function newNode(agentId: string, index: number): WorkflowTemplateNodeDefinition {
  return { id: `node-${crypto.randomUUID()}`, title: `节点 ${index}`, agentId, prompt: "", dependsOn: [] }
}
function messageOf(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function safeFileName(value: string): string {
  const cleaned = [...value].map((character) => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character).join("")
  return cleaned.slice(0, 80) || "workflow-template"
}
