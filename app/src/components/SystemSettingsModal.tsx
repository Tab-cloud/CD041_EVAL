import { useCallback, useEffect, useState, type ReactNode } from "react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { apiFetch } from "../api"
import type { SystemSettings } from "../system-settings"
import { translate, type TranslationKey } from "../i18n"
import type { AgentInfo, ModelConfig } from "../types"
import type { AppUpdaterState } from "../hooks/useAppUpdater"
import { SCOPE_OPTIONS } from "./chat-helpers"
import { SettingsSearch } from "./SettingsSearch"
import { SettingsToolPolicies } from "./SettingsToolPolicies"
import { SettingsProject } from "./SettingsProject"
import { SettingsDiagnostics } from "./SettingsDiagnostics"
import { SettingsModelRouting } from "./SettingsModelRouting"
import { SettingsToolCenter } from "./SettingsToolCenter"
import { SettingsMcp } from "./SettingsMcp"
import { SettingsSkills } from "./SettingsSkills"
import { SettingsAgents } from "./SettingsAgents"
import { SettingsAccount } from "./SettingsAccount"
import { SettingsCommunity } from "./SettingsCommunity"
import appPackage from "../../package.json"
import type { AccountUser } from "../account"
import {
  ActivityIcon,
  BrainIcon,
  CheckCircleIcon,
  Code2Icon,
  CpuIcon,
  FolderIcon,
  FileTextIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  BotIcon,
  TerminalIcon,
  UserIcon,
  MessageSquareIcon,
  WrenchIcon,
  XIcon,
} from "./Icons"

export type SettingsTab = "account" | "community" | "general" | "agent" | "agents" | "tool-center" | "tools" | "mcp" | "skills" | "search" | "project" | "models" | "diagnostics" | "system"

interface HealthInfo {
  status: string
  tools: number
  agents: number
  scheduler: { queued: number; running: number; completed: number; failed: number; maxConcurrency: number }
}

interface Props {
  settings: SystemSettings
  models: ModelConfig[]
  agents: AgentInfo[]
  workspace: string | null
  connectionStatus: "connected" | "disconnected" | "connecting"
  updaterState: AppUpdaterState
  onCheckForUpdate: () => void
  onOpenUpdate: () => void
  onSave: (settings: SystemSettings) => Promise<void>
  onOpenModels: () => void
  onProjectSettingsChanged: (effective: SystemSettings) => void
  onConfigurationRestored: (settings: SystemSettings) => Promise<void>
  onAgentsChanged: () => Promise<void>
  onClose: () => void
  initialTab?: SettingsTab
  autoStartAccountLogin?: boolean
  onAccountLoginAutoStarted?: () => void
  onAccountChanged: (user: AccountUser | null) => void
}

const TABS: Array<{ id: SettingsTab; labelKey: TranslationKey; Icon: typeof SettingsIcon }> = [
  { id: "account", labelKey: "settings.account", Icon: UserIcon },
  { id: "community", labelKey: "settings.community", Icon: MessageSquareIcon },
  { id: "general", labelKey: "settings.general", Icon: SettingsIcon },
  { id: "agent", labelKey: "settings.agent", Icon: BrainIcon },
  { id: "agents", labelKey: "settings.agents", Icon: BotIcon },
  { id: "tool-center", labelKey: "settings.toolCenter", Icon: WrenchIcon },
  { id: "tools", labelKey: "settings.tools", Icon: ShieldIcon },
  { id: "mcp", labelKey: "settings.mcp", Icon: TerminalIcon },
  { id: "skills", labelKey: "settings.skills", Icon: FileTextIcon },
  { id: "search", labelKey: "settings.search", Icon: SearchIcon },
  { id: "project", labelKey: "settings.project", Icon: FolderIcon },
  { id: "models", labelKey: "settings.models", Icon: Code2Icon },
  { id: "diagnostics", labelKey: "settings.diagnostics", Icon: ActivityIcon },
  { id: "system", labelKey: "settings.system", Icon: CpuIcon },
]

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string

export function SystemSettingsModal({ settings, models, agents, workspace, connectionStatus, updaterState, onCheckForUpdate, onOpenUpdate, onSave, onOpenModels, onProjectSettingsChanged, onConfigurationRestored, onAgentsChanged, onClose, initialTab = "general", autoStartAccountLogin = false, onAccountLoginAutoStarted, onAccountChanged }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [local, setLocal] = useState<SystemSettings>(settings)
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState("")
  const t: Translator = (key, values) => translate(local.language, key, values)

  const loadHealth = useCallback(async () => {
    try {
      const response = await apiFetch("/api/health")
      if (response.ok) setHealth(await response.json())
    } catch { setHealth(null) }
  }, [])

  useEffect(() => { void loadHealth() }, [loadHealth])

  const update = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => {
    setLocal((previous) => ({ ...previous, [key]: value }))
    setDirty(true)
  }

  const requestClose = () => {
    if (dirty && !window.confirm(local.language === "en-US"
      ? "Global settings have unsaved changes. Close without saving?"
      : "全局设置尚未保存，确定关闭并放弃这些改动吗？")) return
    onClose()
  }

  const pickWorkspace = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t("settings.workspace.dialog") })
    if (typeof selected === "string") update("defaultWorkspace", selected)
  }

  const save = async () => {
    if (!dirty) {
      onClose()
      return
    }
    setSaving(true)
    setError("")
    try {
      await onSave(local)
      setDirty(false)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setSaving(false) }
  }

  const openModels = async () => {
    setSaving(true)
    setError("")
    try {
      await onSave(local)
      setDirty(false)
      onOpenModels()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setSaving(false) }
  }

  return (
    <div className="modal-overlay">
      <div className="settings-modal">
        <header className="settings-header">
          <div><strong>{t("settings.title")}</strong><span>Eval</span></div>
          <button className="topbar-icon-btn" onClick={requestClose} title={t("common.close")}><XIcon size={15} /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("settings.nav")}>
            {TABS.map(({ id, labelKey, Icon }) => (
              <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
                <Icon size={15} /><span>{t(labelKey)}</span>
              </button>
            ))}
          </nav>
          <main className="settings-content">
            {tab === "account" && <SettingsAccount language={local.language} required autoStart={autoStartAccountLogin} onAutoStartConsumed={onAccountLoginAutoStarted} onAccountChanged={onAccountChanged} />}
            {tab === "community" && <SettingsCommunity settings={local} update={update} />}
            {tab === "general" && <GeneralSettings settings={local} update={update} pickWorkspace={pickWorkspace} t={t} />}
            {tab === "agent" && <AgentSettings settings={local} agents={agents} update={update} />}
            {tab === "agents" && <SettingsAgents workspace={workspace} onChanged={onAgentsChanged} />}
            {tab === "tool-center" && <SettingsToolCenter settings={local} workspace={workspace} update={update} />}
            {tab === "tools" && <SettingsToolPolicies settings={local} update={update} />}
            {tab === "mcp" && <SettingsMcp workspace={workspace} />}
            {tab === "skills" && <SettingsSkills settings={local} workspace={workspace} update={update} />}
            {tab === "search" && <SettingsSearch settings={local} update={update} />}
            {tab === "project" && <SettingsProject projectPath={workspace} globalSettings={local} agents={agents} models={models} onChanged={onProjectSettingsChanged} />}
            {tab === "models" && <SettingsModelRouting settings={local} update={update} models={models} agents={agents} onOpenModels={() => void openModels()} />}
            {tab === "diagnostics" && <SettingsDiagnostics settings={local} onRestored={async (restored) => { setLocal(restored); setDirty(false); await onConfigurationRestored(restored) }} />}
            {tab === "system" && (
              <SystemStatus settings={local} update={update} connectionStatus={connectionStatus} health={health} updaterState={updaterState} onCheckForUpdate={onCheckForUpdate} onOpenUpdate={onOpenUpdate} reload={loadHealth} t={t} />
            )}
          </main>
        </div>
        <footer className="settings-footer">
          {error && <span className="settings-error">{error}</span>}
          {!error && <span className="settings-result-line">{local.language === "en-US" ? "Global options use Save; Agent, MCP, Skill, project and diagnostics actions apply immediately." : "全局选项点击保存后生效；Agent、MCP、Skill、项目与诊断操作会立即保存。"}</span>}
          <button className="btn btn-ghost" onClick={requestClose}>{t("common.close")}</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? t("common.saving") : local.language === "en-US" ? "Save and close" : "保存并退出"}</button>
        </footer>
      </div>
    </div>
  )
}

type UpdateSetting = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => void

function GeneralSettings({ settings, update, pickWorkspace, t }: { settings: SystemSettings; update: UpdateSetting; pickWorkspace: () => void; t: Translator }) {
  return <section className="settings-section">
    <h2>{t("settings.general")}</h2>
    <SettingRow title={t("settings.language.title")} description={t("settings.language.description")}>
      <select value={settings.language} onChange={(event) => update("language", event.target.value as SystemSettings["language"])}>
        <option value="zh-CN">{t("settings.language.zh")}</option>
        <option value="en-US">{t("settings.language.en")}</option>
      </select>
    </SettingRow>
    <SettingRow title={t("settings.theme.title")} description={t("settings.theme.description")}>
      <div className="settings-segmented">
        <button className={settings.theme === "dark" ? "active" : ""} onClick={() => update("theme", "dark")}>{t("settings.theme.dark")}</button>
        <button className={settings.theme === "light" ? "active" : ""} onClick={() => update("theme", "light")}>{t("settings.theme.light")}</button>
      </div>
    </SettingRow>
    <SettingRow title={t("settings.restore.title")} description={t("settings.restore.description")}>
      <Switch checked={settings.restoreLastSession} onChange={(value) => update("restoreLastSession", value)} />
    </SettingRow>
    <SettingRow title={t("settings.workspace.title")} description={t("settings.workspace.description")}>
      <button className="settings-path" onClick={pickWorkspace} title={settings.defaultWorkspace || t("settings.workspace.pick")}>
        <FolderIcon size={14} /><span>{settings.defaultWorkspace || t("settings.workspace.pick")}</span>
      </button>
    </SettingRow>
    <SettingRow title={t("settings.serial.title")} description={t("settings.serial.description")}>
      <select value={settings.serialBaudRate} onChange={(event) => update("serialBaudRate", Number(event.target.value))}>
        {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((rate) => <option key={rate}>{rate}</option>)}
      </select>
    </SettingRow>
  </section>
}

function AgentSettings({ settings, agents, update }: { settings: SystemSettings; agents: AgentInfo[]; update: UpdateSetting }) {
  const updateBudget = (values: Partial<SystemSettings["executionBudget"]>) => update("executionBudget", { ...settings.executionBudget, ...values })
  return <section className="settings-section">
    <h2>Agent</h2>
    <div className="settings-field-block">
      <label>默认执行范围</label>
      <div className="settings-scope-grid">
        {SCOPE_OPTIONS.map((option) => <button key={option.id} className={settings.defaultScope === option.id ? "active" : ""} onClick={() => update("defaultScope", option.id)}>
          <span>{option.icon}</span><strong>{option.label}</strong><small>{option.desc}</small>
        </button>)}
      </div>
    </div>
    <SettingRow title="默认开启思考" description="允许支持推理的模型输出内部思考过程。">
      <Switch checked={settings.defaultEffort === "on"} onChange={(value) => update("defaultEffort", value ? "on" : "off")} />
    </SettingRow>
    <SettingRow title="默认 Agent" description="自动分派前优先使用；留空会根据任务内容选择。">
      <select value={settings.preferredAgentId} onChange={(event) => update("preferredAgentId", event.target.value)}><option value="">自动分派</option>{agents.filter((agent) => agent.mode !== "hidden").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
    </SettingRow>
    <SettingRow title="工作区语义索引" description="对工作区建立本地索引，为模型补充相关代码上下文。">
      <Switch checked={settings.workspaceIndexing} onChange={(value) => update("workspaceIndexing", value)} />
    </SettingRow>
    <SettingRow title="自动展开工具输出" description="终端、编译或串口产生输出时自动展开底部面板。">
      <Switch checked={settings.autoOpenOutput} onChange={(value) => update("autoOpenOutput", value)} />
    </SettingRow>
    <SettingRow title="完整目标最长时间" description="同一目标包含自动续段、恢复和最终验收在内的绝对总时限。">
      <input className="settings-number" type="number" min="5" max="1440" step="5" value={settings.executionBudget.totalDurationMs / 60_000} onChange={(event) => updateBudget({ totalDurationMs: Number(event.target.value) * 60_000 })} />
    </SettingRow>
    <SettingRow title="单次根执行窗口" description="一个执行窗口的时长；窗口结束后仍有待办时可在总时限内自动续租。">
      <input className="settings-number" type="number" min="5" max={settings.executionBudget.totalDurationMs / 60_000} step="5" value={settings.executionBudget.rootWindowMs / 60_000} onChange={(event) => updateBudget({ rootWindowMs: Number(event.target.value) * 60_000 })} />
    </SettingRow>
    <SettingRow title="最多根执行窗口" description="限制自动续租次数，避免无进展循环；仍受完整目标总时限约束。">
      <input className="settings-number" type="number" min="1" max="288" step="1" value={settings.executionBudget.maxRootWindows} onChange={(event) => updateBudget({ maxRootWindows: Number(event.target.value) })} />
    </SettingRow>
    <SettingRow title="单个子任务租约" description="一次委派最多占用的时间；到期后由父 Agent 接管或缩小范围。">
      <input className="settings-number" type="number" min="0.1" max={settings.executionBudget.rootWindowMs / 60_000} step="0.5" value={settings.executionBudget.childLeaseMs / 60_000} onChange={(event) => updateBudget({ childLeaseMs: Number(event.target.value) * 60_000 })} />
    </SettingRow>
    <SettingRow title="父任务恢复预留" description="禁止子 Agent 消耗的恢复、验证和交付时间。">
      <input className="settings-number" type="number" min="1" max={settings.executionBudget.rootWindowMs / 120_000} step="0.5" value={settings.executionBudget.parentReserveMs / 60_000} onChange={(event) => updateBudget({ parentReserveMs: Number(event.target.value) * 60_000 })} />
    </SettingRow>
  </section>
}

function SystemStatus({ settings, update, connectionStatus, health, updaterState, onCheckForUpdate, onOpenUpdate, reload, t }: { settings: SystemSettings; update: UpdateSetting; connectionStatus: string; health: HealthInfo | null; updaterState: AppUpdaterState; onCheckForUpdate: () => void; onOpenUpdate: () => void; reload: () => void; t: Translator }) {
  const updateDetected = updaterState.phase === "available" || updaterState.phase === "downloading" || updaterState.phase === "installing"
  const updateLabel = updaterState.phase === "checking" ? t("settings.system.updateChecking")
    : updateDetected ? t("settings.system.updateView")
      : t("settings.system.updateCheck")
  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>{t("settings.system")}</h2><p>{localSystemText(settings.language, "status")}</p></div><button className="topbar-icon-btn" onClick={reload} title={t("common.refresh")}><RefreshCwIcon size={14} /></button></div>
    <div className="settings-status-grid">
      <StatusItem label="后端服务" value={connectionStatus === "connected" ? "已连接" : connectionStatus === "connecting" ? "连接中" : "未连接"} icon={<CheckCircleIcon size={15} />} />
      <StatusItem label="Agent" value={String(health?.agents ?? "-")} icon={<BrainIcon size={15} />} />
      <StatusItem label="工具" value={String(health?.tools ?? "-")} icon={<ShieldIcon size={15} />} />
      <StatusItem label="任务" value={health ? `${health.scheduler.running} 运行 / ${health.scheduler.queued} 排队` : "-"} icon={<CpuIcon size={15} />} />
    </div>
    <div className="settings-system-rows"><div><span>{t("settings.system.version")}</span><div className="settings-update-control"><strong>{appPackage.version}</strong><button className={`btn btn-sm settings-update-button ${updateDetected ? "available" : "btn-secondary"}`} onClick={updateDetected ? onOpenUpdate : onCheckForUpdate} disabled={updaterState.phase === "checking"}><RefreshCwIcon size={12} className={updaterState.phase === "checking" ? "spin" : undefined} />{updateLabel}</button></div></div><div><span>最大并发任务</span><strong>{health?.scheduler.maxConcurrency ?? "-"}</strong></div><div><span>数据存储</span><code>~/.eval/eval.db</code></div><div><span>凭据轮换检查周期</span><select value={settings.credentialRotationDays} onChange={(event) => update("credentialRotationDays", Number(event.target.value))}>{[30, 60, 90, 180, 365].map((days) => <option key={days} value={days}>{days} 天</option>)}</select></div></div>
  </section>
}

function localSystemText(language: SystemSettings["language"], key: "status"): string {
  if (key === "status") return language === "en-US" ? "Runtime status and local data" : "运行状态与本地数据"
  return ""
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-control">{children}</div></div>
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <button className={`settings-switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>
}

function StatusItem({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return <div className="settings-status-item"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>
}
