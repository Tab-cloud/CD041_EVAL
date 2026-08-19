import type { AppUpdaterState } from "../hooks/useAppUpdater"
import { useI18n } from "../i18n"
import { DownloadIcon, RefreshCwIcon, ShieldIcon, XIcon } from "./Icons"

interface Props {
  state: AppUpdaterState
  onInstall: () => void
  onRetry: () => void
  onClose: () => void
}

const copy = {
  "zh-CN": {
    eyebrow: "SIGNED RELEASE / 安全升级",
    title: "新版本已准备就绪",
    checking: "正在检查更新",
    idle: "当前已是最新版本",
    error: "更新检查未完成",
    current: "当前版本",
    next: "目标版本",
    notes: "版本说明",
    fallbackNotes: "此版本包含稳定性、安全性与体验改进。",
    mandatory: "此版本为必要升级，安装完成前不能跳过。",
    signed: "安装包由 Eval 发布密钥签名，客户端将在安装前完成校验。",
    later: "稍后提醒",
    install: "下载并安装",
    retry: "重新检查",
    downloading: "正在下载",
    installing: "正在安装，应用即将重启",
  },
  "en-US": {
    eyebrow: "SIGNED RELEASE / SECURE UPDATE",
    title: "A new version is ready",
    checking: "Checking for updates",
    idle: "You are up to date",
    error: "Update check could not finish",
    current: "Current",
    next: "Next",
    notes: "Release notes",
    fallbackNotes: "This release includes stability, security, and experience improvements.",
    mandatory: "This update is required and cannot be skipped before installation.",
    signed: "The package is signed by Eval and verified before installation.",
    later: "Later",
    install: "Download and install",
    retry: "Check again",
    downloading: "Downloading",
    installing: "Installing. Eval will restart shortly",
  },
} as const

export function UpdateDialog({ state, onInstall, onRetry, onClose }: Props) {
  const { language } = useI18n()
  if (!state.open) return null
  const text = copy[language]
  const progress = state.totalBytes && state.totalBytes > 0
    ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
    : null
  const busy = state.phase === "downloading" || state.phase === "installing"
  const title = state.phase === "checking" ? text.checking
    : state.phase === "idle" ? text.idle
      : state.phase === "error" ? text.error
        : text.title

  return (
    <div className="update-dialog-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="update-dialog" role="alertdialog" aria-modal="true" aria-labelledby="update-dialog-title">
        {!state.mandatory && !busy && (
          <button className="update-dialog-close" onClick={onClose} aria-label={text.later}><XIcon size={16} /></button>
        )}
        <div className="update-dialog-signal" aria-hidden="true"><span /><span /><span /></div>
        <div className="update-dialog-eyebrow"><ShieldIcon size={14} />{text.eyebrow}</div>
        <h2 id="update-dialog-title">{title}</h2>

        {state.version && (
          <div className="update-version-rail">
            <div><span>{text.current}</span><strong>{state.currentVersion}</strong></div>
            <div className="update-version-line"><span /></div>
            <div><span>{text.next}</span><strong>{state.version}</strong></div>
          </div>
        )}

        {state.phase === "available" && (
          <>
            <div className="update-release-notes">
              <span>{text.notes}</span>
              <p>{state.notes || text.fallbackNotes}</p>
            </div>
            {state.mandatory && <p className="update-mandatory">{text.mandatory}</p>}
            <p className="update-signature-note"><ShieldIcon size={13} />{text.signed}</p>
          </>
        )}

        {busy && (
          <div className="update-progress-block">
            <div><span>{state.phase === "installing" ? text.installing : text.downloading}</span><strong>{progress === null ? "—" : `${progress}%`}</strong></div>
            <div className={`update-progress-track ${progress === null ? "indeterminate" : ""}`}><span style={progress === null ? undefined : { width: `${progress}%` }} /></div>
          </div>
        )}

        {state.phase === "error" && <p className="update-error-message">{state.error}</p>}

        <div className="update-dialog-actions">
          {!state.mandatory && !busy && state.phase !== "checking" && <button className="update-secondary" onClick={onClose}>{text.later}</button>}
          {state.phase === "available" && <button className="update-primary" onClick={onInstall}><DownloadIcon size={16} />{text.install}</button>}
          {(state.phase === "error" || state.phase === "idle") && <button className="update-primary" onClick={onRetry}><RefreshCwIcon size={16} />{text.retry}</button>}
        </div>
      </section>
    </div>
  )
}
