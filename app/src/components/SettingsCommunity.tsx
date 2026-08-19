import { useCallback, useEffect, useState } from "react"
import { loadAccountProfile, openAccountBinding, type AccountUser } from "../account"
import { loadCommunityCapabilities, type CommunityCapabilities, type CommunityScope } from "../community"
import type { CommunityAutomationSettings, SystemSettings, ToolPolicyMode } from "../system-settings"
import { ExternalLinkIcon, RefreshCwIcon, SpinnerIcon } from "./Icons"

type UpdateSetting = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => void

const CONTROLS: Array<{
  key: keyof Omit<CommunityAutomationSettings, "enabled">
  scope: CommunityScope
  title: string
  description: string
}> = [
  { key: "forumExplore", scope: "community.forum.read", title: "论坛探索", description: "读取、筛选和总结论坛主题；外部内容始终按不可信资料处理。" },
  { key: "forumReply", scope: "community.forum.reply.create", title: "论坛回复", description: "以当前账号公开回复已有主题。" },
  { key: "forumCreateTopic", scope: "community.forum.topic.create", title: "论坛发帖", description: "创建新的公开论坛主题。" },
  { key: "blogCreateDraft", scope: "community.blog.draft.create", title: "博客草稿", description: "创建或更新草稿，不会直接公开。" },
  { key: "blogPublish", scope: "community.blog.publish", title: "自动发布博客", description: "把 Eval 创建的草稿公开发布；仅管理员账号可获此权限。" },
]

export function SettingsCommunity({ settings, update }: { settings: SystemSettings; update: UpdateSetting }) {
  const en = settings.language === "en-US"
  const [account, setAccount] = useState<AccountUser | null>(null)
  const [capabilities, setCapabilities] = useState<CommunityCapabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const profile = await loadAccountProfile()
      setAccount(profile)
      setCapabilities(profile ? await loadCommunityCapabilities() : null)
    } catch (reason) {
      setCapabilities(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const setCommunity = (values: Partial<CommunityAutomationSettings>) => {
    update("communityAutomation", { ...settings.communityAutomation, ...values })
  }
  const openConsole = () => void openAccountBinding("https://eval.zailink.space/console?view=community")
  const activeScopes = new Set(capabilities?.scopes ?? [])

  return <section className="settings-section community-settings">
    <div className="settings-section-title"><div>
      <h2>{en ? "Web community" : "Web 社区"}</h2>
      <p>{en ? "Explore or publish through your Eval Web identity with layered permissions." : "使用 Eval Web 身份探索论坛或发布内容；管理员、账号、设备和本地策略共同约束。"}</p>
    </div><button className="topbar-icon-btn" onClick={() => void refresh()} title={en ? "Refresh capabilities" : "刷新社区能力"}><RefreshCwIcon size={14}/></button></div>

    {loading ? <div className="community-status"><SpinnerIcon size={14} className="spin"/>{en ? "Checking Web authorization…" : "正在检查 Web 授权…"}</div>
      : <div className={`community-status ${capabilities?.enabled ? "ready" : "warning"}`}>
        <span className="settings-status-dot online"/>
        <div><strong>{account ? `${account.displayName} · ${capabilities?.enabled ? (en ? "Available" : "已授权") : (en ? "No effective scopes" : "尚无有效权限")}` : (en ? "Not signed in" : "尚未登录")}</strong>
          <small>{account ? (en ? `${capabilities?.scopes.length ?? 0} effective permissions` : `${capabilities?.scopes.length ?? 0} 项 Web 有效权限`) : (en ? "Bind an Eval Web account first" : "请先在账号页绑定 Eval Web 账号")}</small></div>
        <button className="btn btn-sm btn-ghost" onClick={openConsole}><ExternalLinkIcon size={12}/>{en ? "Web permissions" : "Web 授权"}</button>
      </div>}
    {error && <div className="account-error" role="alert">{error}</div>}

    <div className="settings-row community-master"><div><strong>{en ? "Allow community automation" : "允许社区自动化"}</strong><p>{en ? "Master switch. Turning it off makes every local community tool unavailable." : "本地父级开关；关闭后所有社区工具立即不可用，但不会扩大或修改 Web 授权。"}</p></div><div className="settings-control"><Toggle checked={settings.communityAutomation.enabled} disabled={!account && !settings.communityAutomation.enabled} onChange={(enabled) => setCommunity({ enabled })}/></div></div>

    <div className={!settings.communityAutomation.enabled || !account ? "community-policy-list disabled" : "community-policy-list"}>
      {CONTROLS.map((control) => <div className="settings-policy-row" key={control.key}><div><strong>{en ? englishTitle(control.key) : control.title}</strong><p>{en ? englishDescription(control.key) : control.description}</p><span className={activeScopes.has(control.scope) ? "community-scope granted" : "community-scope"}>{activeScopes.has(control.scope) ? (en ? "Web granted" : "Web 已授权") : (en ? "Web not granted" : "Web 未授权")}</span></div><select disabled={!settings.communityAutomation.enabled || !account} value={settings.communityAutomation[control.key]} onChange={(event) => setCommunity({ [control.key]: event.target.value as ToolPolicyMode })}><option value="allow">{en ? "Allow" : "允许"}</option><option value="ask">{en ? "Ask every time" : "每次询问"}</option><option value="deny">{en ? "Deny" : "禁止"}</option></select></div>)}
    </div>

    {capabilities && <div className="community-limits"><span>{en ? "Server limits" : "服务端限额"}</span><code>{en ? `${capabilities.limits.forumTopicsPerHour} topics/h · ${capabilities.limits.forumRepliesPerHour} replies/h · ${capabilities.limits.blogDraftsPerDay} drafts/day · ${capabilities.limits.blogPublishesPerDay} publishes/day` : `${capabilities.limits.forumTopicsPerHour} 主题/时 · ${capabilities.limits.forumRepliesPerHour} 回复/时 · ${capabilities.limits.blogDraftsPerDay} 草稿/天 · ${capabilities.limits.blogPublishesPerDay} 发布/天`}</code></div>}
    <p className="account-offline-note">{en ? "Local Allow never bypasses Web policy, user consent, device scopes, roles, rate limits or content validation." : "本地“允许”永远不能绕过 Web 全站策略、用户授权、设备 Scope、账号角色、限流和内容校验。"}</p>
  </section>
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button disabled={disabled} className={`settings-switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span/></button>
}

function englishTitle(key: string) {
  return ({ forumExplore: "Forum exploration", forumReply: "Forum replies", forumCreateTopic: "Forum topics", blogCreateDraft: "Blog drafts", blogPublish: "Publish blogs" } as Record<string, string>)[key]
}

function englishDescription(key: string) {
  return ({ forumExplore: "Read and summarize untrusted forum content.", forumReply: "Post a public reply with this account.", forumCreateTopic: "Create a public forum topic.", blogCreateDraft: "Create or update drafts without publishing.", blogPublish: "Publish an Eval-created draft; administrator role required." } as Record<string, string>)[key]
}
