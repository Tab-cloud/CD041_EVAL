import { useCallback, useEffect, useState } from "react"
import { apiFetch } from "../api"
import type { ProjectSettingsOverrides, SystemSettings } from "../system-settings"
import { FileTextIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "./Icons"

interface SkillItem {
  name: string; description: string; version: string; triggers: string[]
  source: "project" | "user" | "builtin"; path: string; enabled: boolean; editable: boolean; preview: string
}

interface Props {
  settings: SystemSettings
  workspace: string | null
  update: <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => void
}

export function SettingsSkills({ settings, workspace, update }: Props) {
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [adding, setAdding] = useState(false)
  const [target, setTarget] = useState<"user" | "project">("user")
  const [location, setLocation] = useState("")
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState("")
  const [scope, setScope] = useState<"global" | "project">("global")
  const [projectOverrides, setProjectOverrides] = useState<ProjectSettingsOverrides>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const suffix = workspace ? `?projectPath=${encodeURIComponent(workspace)}` : ""
      const [response, projectResponse] = await Promise.all([
        apiFetch(`/api/skills${suffix}`),
        workspace ? apiFetch(`/api/project-settings${suffix}`) : Promise.resolve(null),
      ])
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      setSkills(data.skills ?? [])
      if (projectResponse) {
        const projectData = await projectResponse.json()
        if (projectResponse.ok) setProjectOverrides(projectData.overrides ?? {})
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }, [workspace])
  useEffect(() => { void load() }, [load])

  const projectDisabled = projectOverrides.disabledSkillIds ?? []
  const disabledForScope = scope === "global"
    ? settings.disabledSkillIds
    : [...new Set([...settings.disabledSkillIds, ...projectDisabled])]
  const toggle = async (skill: SkillItem) => {
    if (scope === "project" && settings.disabledSkillIds.includes(skill.name)) {
      setStatus("该 Skill 已被全局停用，项目设置不能放宽全局边界")
      return
    }
    const current = scope === "global" ? settings.disabledSkillIds : projectDisabled
    const next = current.includes(skill.name)
      ? current.filter((name) => name !== skill.name) : [...current, skill.name]
    if (scope === "global") { update("disabledSkillIds", next); return }
    if (!workspace) return
    setLoading(true); setStatus("")
    try {
      const overrides = { ...projectOverrides, disabledSkillIds: next }
      const response = await apiFetch("/api/project-settings", { method: "PUT", body: JSON.stringify({ projectPath: workspace, overrides }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      setProjectOverrides(data.overrides ?? overrides); setStatus("项目 Skill 设置已保存")
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  const install = async () => {
    setLoading(true); setStatus("")
    try {
      if (!location.trim() && !content.trim()) throw new Error("请输入本地路径、Git/HTTP 地址或 Skill 内容")
      const response = await apiFetch("/api/skills/install", { method: "POST", body: JSON.stringify({ target, projectPath: workspace, location: location || undefined, content: content || undefined }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      setAdding(false); setLocation(""); setContent(""); setStatus(`已安装 ${data.skill.name}`); await load()
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  const remove = async (skill: SkillItem) => {
    setLoading(true); setStatus("")
    try {
      const response = await apiFetch("/api/skills", { method: "DELETE", body: JSON.stringify({ path: skill.path, projectPath: workspace }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
      setStatus(`已删除 ${skill.name}`); await load()
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>Skill 管理</h2><p>先只向 Agent 提供名称和描述，命中后才加载完整指引。支持标准的“技能目录/SKILL.md”及配套脚本、模板和参考资料，也兼容 .agents/skills 与旧版单文件。</p></div><div className="settings-title-actions"><button className="topbar-icon-btn" onClick={load} title="刷新"><RefreshCwIcon size={14} /></button><button className="topbar-icon-btn" onClick={() => setAdding(true)} title="安装 Skill"><PlusIcon size={14} /></button></div></div>
    <div className="settings-toolbar-row"><span className="settings-toolbar-label">启用范围</span><div className="settings-segmented"><button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>全局</button><button disabled={!workspace} className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>项目</button></div></div>
    <div className="settings-manage-list">
      {skills.map((skill) => {
        const enabled = !disabledForScope.includes(skill.name)
        const globallyLocked = scope === "project" && settings.disabledSkillIds.includes(skill.name)
        return <details className="settings-skill-row" key={`${skill.source}-${skill.name}`}>
          <summary><span className="settings-manage-icon"><FileTextIcon size={14} /></span><span className="settings-manage-main"><strong>{skill.name}<small>{sourceLabel(skill.source)} · v{skill.version}</small></strong><span>{skill.description}</span></span><span className={`settings-switch ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled} aria-disabled={globallyLocked} title={globallyLocked ? "已被全局停用" : undefined} onClick={(event) => { event.preventDefault(); void toggle(skill) }}><span /></span>{skill.editable && <button className="topbar-icon-btn" onClick={(event) => { event.preventDefault(); void remove(skill) }} title="删除"><Trash2Icon size={12} /></button>}</summary>
          <div className="settings-skill-detail">{skill.triggers.length > 0 && <p>触发词：{skill.triggers.join("、")}</p>}<pre>{skill.preview}</pre></div>
        </details>
      })}
      {!loading && skills.length === 0 && <div className="settings-empty-state">未发现 Skill</div>}
    </div>
    {adding && <div className="settings-editor-panel">
      <div className="settings-toolbar-row"><div className="settings-segmented"><button className={target === "user" ? "active" : ""} onClick={() => setTarget("user")}>用户</button><button disabled={!workspace} className={target === "project" ? "active" : ""} onClick={() => setTarget("project")}>项目</button></div></div>
      <label className="settings-editor-field"><span>本地 Skill 目录 / SKILL.md、Git 仓库或公网 HTTP 地址</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="https://github.com/org/skill.git" /></label>
      <label className="settings-editor-field"><span>或直接粘贴 SKILL.md</span><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={'---\nname: skill-name\ndescription: ...\n---\n\nSkill instructions'} /></label>
      <div className="settings-inline-actions"><button className="btn btn-primary" onClick={install} disabled={loading}>安装</button><button className="btn btn-ghost" onClick={() => setAdding(false)}>取消</button></div>
    </div>}
    {status && <div className="settings-result-line">{status}</div>}
  </section>
}

function sourceLabel(source: SkillItem["source"]): string {
  return source === "project" ? "项目" : source === "user" ? "用户" : "内置"
}
