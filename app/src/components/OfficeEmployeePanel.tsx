import { useRef, useState } from "react"
import type { AgentInfo } from "../types"
import type { OfficeActivity, OfficeAppearance, OfficeOutfit } from "../office/types"
import { agentColor, stateLabel } from "../office/office-model"
import { officePersona } from "../office/office-personas"
import { OFFICE_CHARACTER_PROFILES, officeCharacterProfile } from "../office/office-characters"
import { MessageSquareIcon, SendIcon, ShirtIcon, StopIcon, UploadIcon, UserIcon, XIcon } from "./Icons"

interface Props {
  selected?: OfficeActivity
  agents: AgentInfo[]
  appearance: OfficeAppearance
  ownedOutfitIds: string[]
  now: number
  onAppearance: (appearance: OfficeAppearance) => void
  onCancel: (activity: OfficeActivity) => Promise<void>
  onFollowup: (activity: OfficeActivity, text: string) => void
  onReassign: (activity: OfficeActivity, agentId: string) => void
}

const OUTFITS: Array<{ id: OfficeOutfit; label: string }> = [
  { id: "casual", label: "休闲装" }, { id: "formal", label: "正装" },
  { id: "lab", label: "实验服" }, { id: "hoodie", label: "连帽衫" }, { id: "night-flight", label: "夜航开发者" },
]

export function OfficeEmployeePanel({ selected, agents, appearance, ownedOutfitIds, now, onAppearance, onCancel, onFollowup, onReassign }: Props) {
  const [followup, setFollowup] = useState("")
  const [target, setTarget] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  if (!selected) return <div className="office-employee-empty"><UserIcon size={24} />选择一位员工</div>
  const active = !selected.synthetic && !["standby", "resting", "completed", "failed"].includes(selected.state)
  const uploadAvatar = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith("image/") || file.size > 420_000) {
      setError("头像需为 420 KB 以内的图片")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") onAppearance({ ...appearance, avatarDataUrl: reader.result })
    }
    reader.readAsDataURL(file)
    setError("")
  }
  return (
    <div className="office-employee-panel">
      <div className="office-employee-card">
        <div className="office-employee-avatar" style={{ background: agentColor(selected.agentId) }}>
          {appearance.avatarDataUrl ? <img src={appearance.avatarDataUrl} alt="" /> : initials(selected.agentName ?? selected.agentId)}
        </div>
        <div><strong>{selected.agentName ?? selected.agentId}</strong><span>{selected.agentRole ? `${selected.agentRole} · ` : ""}{stateLabel(selected.state)}{selected.synthetic ? " · 员工名册" : " · 真实任务"}</span></div>
        <p>{selected.activity}</p>
        {selected.toolName && <small>当前工具 · {selected.toolName}</small>}
        {!selected.synthetic && <small>持续时间 · {formatDuration(now - selected.timestamp)}</small>}
      </div>
      <div className="office-appearance-row">
        <UserIcon size={12} />
        <select value={officeCharacterProfile(selected.agentId, appearance.characterId).id} onChange={(event) => onAppearance({ ...appearance, characterId: event.target.value, avatarDataUrl: undefined })} title="选择员工形象">
          {OFFICE_CHARACTER_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.description}</option>)}
        </select>
      </div>
      <div className="office-appearance-row">
        <ShirtIcon size={12} />
        <select value={appearance.outfit} onChange={(event) => onAppearance({ ...appearance, outfit: event.target.value as OfficeOutfit })}>
          {OUTFITS.filter((outfit) => ownedOutfitIds.includes(outfit.id)).map((outfit) => <option key={outfit.id} value={outfit.id}>{outfit.label}</option>)}
        </select>
        <label title="上传自定义头像"><UploadIcon size={12} /><input ref={inputRef} type="file" accept="image/*" onChange={(event) => uploadAvatar(event.target.files?.[0])} /></label>
        {appearance.avatarDataUrl && <button title="移除自定义头像" onClick={() => onAppearance({ ...appearance, avatarDataUrl: undefined })}><XIcon size={11} /></button>}
      </div>
      {error && <div className="office-action-error">{error}</div>}
      <div className="office-role-actions">
        <button disabled={!active || busy} onClick={async () => { setBusy(true); try { await onCancel(selected) } finally { setBusy(false) } }}><StopIcon size={11} />中止</button>
        <div className="office-followup"><MessageSquareIcon size={11} /><input value={followup} onChange={(event) => setFollowup(event.target.value)} placeholder={selected.synthetic ? "给这位员工分配任务…" : "追问这位员工…"} onKeyDown={(event) => {
          if (event.key === "Enter" && followup.trim()) { onFollowup(selected, followup.trim()); setFollowup("") }
        }} /><button disabled={!followup.trim()} onClick={() => { onFollowup(selected, followup.trim()); setFollowup("") }}><SendIcon size={10} /></button></div>
        <div className="office-reassign"><select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">重新分配给…</option>{agents.filter((agent) => agent.id !== selected.agentId && !["title-gen", "summary-gen"].includes(agent.id)).map((agent) => { const persona = officePersona(agent.id, agent.name); return <option value={agent.id} key={agent.id}>{persona.name} · {persona.role}</option> })}</select><button disabled={!target} onClick={() => { onReassign(selected, target); setTarget("") }}><SendIcon size={10} /></button></div>
      </div>
    </div>
  )
}

function initials(name: string): string { return name.replace(/[\s-]/g, "").slice(0, 2).toUpperCase() }
function formatDuration(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1_000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` }
