import { useState } from "react"
import { apiFetch } from "../api"
import type { SearchProviderId, SystemSettings } from "../system-settings"
import { CheckCircleIcon, RefreshCwIcon } from "./Icons"

interface Props {
  settings: SystemSettings
  update: <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => void
}

const PROVIDERS: Array<{ id: SearchProviderId; label: string }> = [
  { id: "auto", label: "自动选择" },
  { id: "duckduckgo", label: "DuckDuckGo 优先" },
  { id: "bing", label: "Bing 优先" },
  { id: "google-news", label: "Google News 优先" },
]

export function SettingsSearch({ settings, update }: Props) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const testSearch = async () => {
    setTesting(true)
    setResult(null)
    try {
      const response = await apiFetch("/api/search/test", {
        method: "POST",
        body: JSON.stringify({ query: "OpenAI", provider: settings.searchProvider, timeoutMs: settings.searchTimeoutMs }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      const provider = payload.result?.provider ?? "搜索服务"
      setResult({ ok: true, text: `${provider} 连接正常` })
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally { setTesting(false) }
  }

  return <section className="settings-section">
    <div className="settings-section-title"><div><h2>联网检索</h2><p>适用于新闻、技术资料、产品信息和其他公开实时内容。</p></div></div>
    <SearchRow title="允许联网检索" description="关闭后，搜索与网页读取工具不会暴露给 Agent。">
      <Switch checked={settings.webSearchEnabled} onChange={(value) => update("webSearchEnabled", value)} />
    </SearchRow>
    <SearchRow title="首选提供商" description="失败时自动尝试其他可用提供商。">
      <select value={settings.searchProvider} disabled={!settings.webSearchEnabled} onChange={(event) => update("searchProvider", event.target.value as SearchProviderId)}>
        {PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
      </select>
    </SearchRow>
    <SearchRow title="请求超时" description="单个搜索提供商的最长等待时间。">
      <select value={settings.searchTimeoutMs} disabled={!settings.webSearchEnabled} onChange={(event) => update("searchTimeoutMs", Number(event.target.value))}>
        {[5000, 10000, 15000, 20000, 30000].map((value) => <option key={value} value={value}>{value / 1000} 秒</option>)}
      </select>
    </SearchRow>
    <SearchRow title="最大结果数" description="限制单次检索返回给模型的条目数量。">
      <input className="settings-number" type="number" min={1} max={10} value={settings.searchMaxResults} disabled={!settings.webSearchEnabled} onChange={(event) => update("searchMaxResults", Math.min(10, Math.max(1, Number(event.target.value) || 1)))} />
    </SearchRow>
    <div className="settings-test-row">
      <button className="btn btn-secondary" disabled={!settings.webSearchEnabled || testing} onClick={testSearch}>{testing ? <RefreshCwIcon size={13} /> : <CheckCircleIcon size={13} />}{testing ? "测试中..." : "测试搜索连接"}</button>
      {result && <span className={result.ok ? "success" : "error"}>{result.text}</span>}
    </div>
  </section>
}

function SearchRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div className="settings-control">{children}</div></div>
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <button className={`settings-switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>
}
