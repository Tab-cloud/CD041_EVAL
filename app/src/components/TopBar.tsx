import { DownloadIcon, SettingsIcon, SunIcon, MoonIcon, FolderOpenIconFlat, UserIcon } from "./Icons"
import { Command } from "@tauri-apps/plugin-shell"
import { useI18n } from "../i18n"
import type { ModelConfig } from "../types"
import { resolveModelDisplayName } from "../model-options"
import { accountInitial, type AccountUser } from "../account"

interface TopBarProps {
  connectionStatus: "connected" | "disconnected" | "connecting"
  activeModelId: string | null
  modelConfigs: ModelConfig[]
  reconnectAttempt: number
  theme: "dark" | "light"
  projectName: string
  workspacePath: string | null
  accountUser: AccountUser | null
  updateAvailable: boolean
  onOpenUpdate: () => void
  onOpenSettings: () => void
  onOpenAccount: () => void
  onToggleTheme: () => void
}

async function openFolder(path: string | null) {
  if (!path) return
  try {
    // Windows: 用 explorer 打开文件夹（已在 capabilities 白名单中注册 explorer.exe）
    const cmd = Command.create("explorer", [path])
    await cmd.execute()
  } catch (e) {
    console.error("[openFolder] failed:", e)
  }
}

export function TopBar({
  connectionStatus, activeModelId, modelConfigs, reconnectAttempt, theme, projectName, workspacePath,
  accountUser, updateAvailable, onOpenUpdate, onOpenSettings, onOpenAccount, onToggleTheme,
}: TopBarProps) {
  const { t } = useI18n()
  const modelDisplayName = resolveModelDisplayName(modelConfigs, activeModelId, t("topbar.autoRoute"))
  return (
    <div className="topbar">
      <div className="topbar-title-area">
        <div className="topbar-project-pill" title={t("topbar.openFolder", { path: workspacePath ?? t("topbar.noWorkspace") })} onClick={() => openFolder(workspacePath)} style={{ cursor: workspacePath ? "pointer" : "default" }}>
          <FolderOpenIconFlat size={13} /> <span>{projectName}</span>
        </div>
      </div>

      <div className="topbar-spacer" />

      <div className="topbar-actions">
        <div className="topbar-status">
          <span className={`topbar-status-dot ${connectionStatus !== "connected" ? (connectionStatus === "connecting" ? "connecting" : "disconnected") : ""}`} />
          <span>{connectionStatus === "connected" ? modelDisplayName
            : connectionStatus === "connecting" ? (reconnectAttempt > 0 ? t("topbar.reconnecting", { count: reconnectAttempt }) : t("common.connecting"))
            : t("common.offline")}</span>
        </div>
        {updateAvailable && (
          <button className="topbar-update-btn" onClick={onOpenUpdate} title={t("topbar.updateAvailable")} aria-label={t("topbar.updateAvailable")}>
            <DownloadIcon size={13} />
          </button>
        )}
        <button
          className={`topbar-icon-btn topbar-account-icon${accountUser ? " signed-in" : ""}`}
          onClick={onOpenAccount}
          title={accountUser ? `${accountUser.displayName} · ${t("topbar.account")}` : t("topbar.account")}
          aria-label={accountUser ? `${accountUser.displayName} · ${t("topbar.account")}` : t("topbar.account")}
        >
          {accountUser
            ? <span className="topbar-account-initial" aria-hidden="true">{accountInitial(accountUser)}</span>
            : <UserIcon size={16} />}
        </button>
        <button className="topbar-icon-btn" onClick={onOpenSettings} title={t("topbar.settings")}><SettingsIcon size={14} /></button>
        <button className="theme-toggle" onClick={onToggleTheme} title={theme === "dark" ? t("topbar.lightMode") : t("topbar.darkMode")}>
          {theme === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
        </button>
      </div>
    </div>
  )
}
