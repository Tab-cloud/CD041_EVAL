import type { AccountUser } from "../account"
import type { AppLanguage } from "../i18n-messages"
import { SettingsAccount } from "./SettingsAccount"
import { SpinnerIcon } from "./Icons"

interface AccountGateProps {
  language: AppLanguage
  checking: boolean
  onAccountChanged: (user: AccountUser | null) => void
}

export function AccountGate({ language, checking, onAccountChanged }: AccountGateProps) {
  const en = language === "en-US"

  return (
    <main className="account-gate">
      <section className="account-gate-card" aria-live="polite">
        <header className="account-gate-header">
          <div className="account-gate-brand"><span aria-hidden="true" />Eval</div>
          <p>{en ? "ACCOUNT ACCESS" : "账号准入"}</p>
          <h1>{en ? "Sign in to use Eval" : "登录后使用 Eval"}</h1>
          <span>{en
            ? "Your account is verified before sessions, task recovery, queues, and Agent tools are started."
            : "完成账号校验后，才会启动会话、任务恢复、指令队列与 Agent 工具。"}</span>
        </header>
        {checking ? (
          <div className="account-gate-checking" role="status">
            <SpinnerIcon size={18} className="spin" />
            <strong>{en ? "Verifying account…" : "正在校验账号状态…"}</strong>
          </div>
        ) : (
          <SettingsAccount language={language} required onAccountChanged={onAccountChanged} />
        )}
      </section>
    </main>
  )
}
