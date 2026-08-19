import { useCallback, useEffect, useRef, useState } from "react"
import {
  accountBindingAvailable,
  beginAccountLogin,
  DesktopAccountBindingUnavailableError,
  loadAccountProfile,
  logoutAccount,
  openAccountBinding,
  pollAccountBinding,
  accountInitial,
  type AccountBinding,
  type AccountUser,
} from "../account"
import type { AppLanguage } from "../i18n-messages"
import { CheckCircleIcon, ExternalLinkIcon, RefreshCwIcon, SpinnerIcon, UserIcon } from "./Icons"

interface SettingsAccountProps {
  language: AppLanguage
  required?: boolean
  autoStart?: boolean
  onAutoStartConsumed?: () => void
  onAccountChanged?: (user: AccountUser | null) => void
}

export function SettingsAccount({ language, required = false, autoStart = false, onAutoStartConsumed, onAccountChanged }: SettingsAccountProps) {
  const en = language === "en-US"
  const [user, setUser] = useState<AccountUser | null>(null)
  const [binding, setBinding] = useState<AccountBinding | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const autoStartPending = useRef(autoStart)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError("")
    setNotice("")
    try {
      const profile = await loadAccountProfile()
      setUser(profile)
      onAccountChanged?.(profile)
    }
    catch (reason) {
      if (reason instanceof DesktopAccountBindingUnavailableError) {
        setUser(null)
        setNotice(en ? "Desktop account binding is not yet available on this server. You can still sign in on Eval Web." : "当前线上服务尚未启用桌面账号绑定，仍可前往 Eval Web 正常登录。")
      } else setError(messageOf(reason))
    }
    finally { setLoading(false) }
  }, [en, onAccountChanged])

  const start = useCallback(async () => {
    setLoading(true)
    setError("")
    setNotice("")
    try {
      const result = await beginAccountLogin()
      if (result.mode === "desktop-binding") setBinding(result.binding)
      else setNotice(en ? "Eval Web sign-in has opened in your browser. Desktop binding will become available after the server update." : "已在浏览器打开 Eval Web 登录。线上服务更新后，桌面账号将自动支持安全绑定。")
    }
    catch (reason) { setError(messageOf(reason)) }
    finally { setLoading(false) }
  }, [en])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!autoStartPending.current || loading || user || binding || error) return
    autoStartPending.current = false
    onAutoStartConsumed?.()
    void start()
  }, [binding, error, loading, onAutoStartConsumed, start, user])

  useEffect(() => {
    if (!binding) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = Date.now() + binding.expiresIn * 1_000
    const poll = async () => {
      if (!active) return
      if (Date.now() >= deadline) {
        setBinding(null)
        setError(en ? "The device authorization request expired. Start again." : "设备绑定请求已经过期，请重新发起。")
        return
      }
      try {
        const profile = await pollAccountBinding(binding.deviceCode)
        if (profile && active) {
          setUser(profile)
          onAccountChanged?.(profile)
          setBinding(null)
          setError("")
          return
        }
      } catch (reason) {
        if (active) {
          setBinding(null)
          setError(messageOf(reason))
        }
        return
      }
      timer = setTimeout(poll, binding.interval * 1_000)
    }
    timer = setTimeout(poll, binding.interval * 1_000)
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [binding, en, onAccountChanged])

  const logout = async () => {
    setLoading(true)
    setError("")
    try { await logoutAccount(); setUser(null); setBinding(null); onAccountChanged?.(null) }
    catch (reason) { setError(messageOf(reason)) }
    finally { setLoading(false) }
  }

  return <section className="settings-section account-settings">
    <div className="settings-section-title"><div>
      <h2>{en ? "Account" : "账号"}</h2>
      <p>{en ? "Bind this desktop to your Eval Web account." : "将当前桌面端与 Eval Web 账号安全绑定。"}</p>
    </div><button className="topbar-icon-btn" onClick={() => void refresh()} title={en ? "Refresh account" : "刷新账号状态"}><RefreshCwIcon size={14}/></button></div>

    {!accountBindingAvailable() && <div className="account-notice">{en ? "Account binding is available in the packaged desktop app." : "账号绑定仅在正式桌面程序中可用。"}</div>}
    {notice && <div className="account-notice" role="status">{notice}</div>}
    {error && <div className="account-error" role="alert">{error}</div>}

    {loading && !binding ? <div className="account-loading"><SpinnerIcon size={16} className="spin"/>{en ? "Checking account…" : "正在检查账号状态…"}</div>
      : user ? <div className="account-profile">
        <div className="account-avatar"><span className="account-avatar-initial">{accountInitial(user)}</span></div>
        <div className="account-identity"><strong>{user.displayName}</strong><span>{user.email || user.username || (en ? "Eval Web account" : "Eval Web 账号")}</span></div>
        <span className="account-bound"><CheckCircleIcon size={13}/>{en ? "Bound" : "已绑定"}</span>
        <dl>
          <div><dt>{en ? "Role" : "账号角色"}</dt><dd>{roleLabel(user.role, en)}</dd></div>
          <div><dt>{en ? "Storage" : "凭据存储"}</dt><dd>{en ? "Windows Credential Manager" : "Windows 凭据管理器"}</dd></div>
        </dl>
        <div className="account-actions">
          <button className="btn btn-ghost" onClick={() => void openAccountBinding("https://eval.zailink.space/console")}><ExternalLinkIcon size={13}/>{en ? "Web console" : "打开 Web 控制台"}</button>
          <button className="btn btn-ghost danger" onClick={() => void logout()}>{en ? "Sign out" : "退出登录"}</button>
        </div>
      </div> : binding ? <div className="account-binding">
        <div className="account-binding-state"><SpinnerIcon size={16} className="spin"/><div><strong>{en ? "Waiting for browser confirmation" : "等待浏览器确认"}</strong><span>{en ? "Sign in on the opened Eval Web page and approve this device." : "请在已打开的 Eval Web 页面登录，并确认绑定当前设备。"}</span></div></div>
        <div className="account-user-code"><span>{en ? "Verification code" : "设备验证码"}</span><strong>{binding.userCode}</strong></div>
        <div className="account-actions">
          <button className="btn btn-ghost" onClick={() => void openAccountBinding(binding.verificationUriComplete)}><ExternalLinkIcon size={13}/>{en ? "Open browser again" : "重新打开浏览器"}</button>
          <button className="btn btn-ghost" onClick={() => setBinding(null)}>{en ? "Cancel" : "取消"}</button>
        </div>
      </div> : <div className="account-empty">
        <div className="account-avatar"><UserIcon size={24}/></div>
        <h3>{en ? "Not signed in" : "尚未登录"}</h3>
        <p>{en ? "Use your existing Web account. Eval never asks for your password inside the desktop app." : "使用已有 Web 账号绑定。桌面端不会要求输入 Web 密码或短信验证码。"}</p>
        <button className="btn btn-primary" onClick={() => void start()} disabled={!accountBindingAvailable()}>{en ? "Sign in with Eval Web" : "使用 Eval Web 账号登录"}</button>
      </div>}

    <p className="account-offline-note">{required
      ? en
        ? "A verified Eval Web account is required. Sessions, tasks, queues, and Agent tools remain locked until sign-in succeeds."
        : "必须通过 Eval Web 账号校验；登录成功前，会话、任务、指令队列与 Agent 工具保持锁定。"
      : en
        ? "A verified Eval Web account is required to continue using Eval."
        : "继续使用 Eval 需要通过 Eval Web 账号校验。"}</p>
  </section>
}

function roleLabel(role: AccountUser["role"], en: boolean) {
  const labels = en
    ? { admin: "Administrator", member: "Member" }
    : { admin: "管理员", member: "成员" }
  return labels[role]
}

function messageOf(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}
