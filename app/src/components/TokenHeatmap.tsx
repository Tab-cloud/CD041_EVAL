import { useCallback, useEffect, useMemo, useState } from "react"
import { apiFetch } from "../api"
import {
  formatCompactTokens,
  heatmapSlots,
  normalizeTokenUsageHeatmap,
  tokenHeatLevel,
  type TokenUsageHeatmap,
} from "../token-usage-heatmap"
import { useI18n } from "../i18n"
import { BarChartIcon, RefreshCwIcon } from "./Icons"

interface TokenHeatmapProps {
  activeSessionId: string | null
  isStreaming: boolean
}

export function TokenHeatmap({ activeSessionId, isStreaming }: TokenHeatmapProps) {
  const { t } = useI18n()
  const [scope, setScope] = useState<"all" | "session">("all")
  const [heatmap, setHeatmap] = useState<TokenUsageHeatmap | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async (signal?: AbortSignal) => {
    const effectiveScope = scope === "session" && activeSessionId ? "session" : "all"
    const query = new URLSearchParams({ days: "91", scope: effectiveScope })
    if (effectiveScope === "session" && activeSessionId) query.set("sessionId", activeSessionId)
    try {
      setLoading(true)
      const response = await apiFetch(`/api/usage/heatmap?${query}`, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const normalized = normalizeTokenUsageHeatmap(await response.json())
      if (!normalized) throw new Error("invalid token heatmap response")
      setHeatmap(normalized)
      setError("")
    } catch (loadError) {
      if (signal?.aborted) return
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [activeSessionId, scope])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = window.setInterval(() => void load(controller.signal), 60_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [load, isStreaming])

  useEffect(() => {
    if (!activeSessionId && scope === "session") setScope("all")
  }, [activeSessionId, scope])

  const slots = useMemo(() => heatmapSlots(heatmap?.days ?? []), [heatmap])
  const maximum = useMemo(
    () => Math.max(0, ...(heatmap?.days ?? []).map((day) => day.totalTokens)),
    [heatmap],
  )
  const estimated = (heatmap?.totals.estimatedCalls ?? 0) > 0
  const cycleScope = () => {
    if (!activeSessionId) return
    setScope((current) => current === "all" ? "session" : "all")
  }

  return (
    <section className="token-heatmap-panel" aria-label={t("sidebar.tokenUsage")}>
      <header className="token-heatmap-header">
        <button
          type="button"
          className="token-heatmap-title"
          onClick={cycleScope}
          title={activeSessionId ? t("sidebar.tokenScopeHint") : t("sidebar.tokenAll")}
        >
          <BarChartIcon size={12} />
          <span>{t("sidebar.tokenUsage")}</span>
          <span className="token-heatmap-scope">
            {scope === "session" && activeSessionId
              ? t("sidebar.tokenSession")
              : t("sidebar.tokenAll")}
          </span>
        </button>
        <button
          type="button"
          className={`token-heatmap-refresh ${loading ? "loading" : ""}`}
          onClick={() => void load()}
          title={t("common.refresh")}
          disabled={loading}
        >
          <RefreshCwIcon size={11} />
        </button>
      </header>

      {error ? (
        <div className="token-heatmap-empty">{t("sidebar.tokenUnavailable")}</div>
      ) : (
        <>
          <div className="token-heatmap-grid" aria-label={t("sidebar.tokenLastDays")}>
            {slots.map((day, index) => day ? (
              <span
                key={day.date}
                className={`token-heatmap-cell level-${tokenHeatLevel(day.totalTokens, maximum)}`}
                title={`${day.date}\n${t("sidebar.tokenTotal")}: ${formatCompactTokens(day.totalTokens)}\n${t("sidebar.tokenInput")}: ${formatCompactTokens(day.promptTokens)}\n${t("sidebar.tokenOutput")}: ${formatCompactTokens(day.completionTokens)}\n${t("sidebar.tokenCalls")}: ${day.calls}${day.estimatedCalls ? `\n${t("sidebar.tokenEstimated")}: ${day.estimatedCalls}` : ""}`}
              />
            ) : <span key={`empty-${index}`} className="token-heatmap-cell spacer" />)}
          </div>
          <footer className="token-heatmap-footer">
            <span>
              {t("sidebar.tokenLastDays")} · {formatCompactTokens(heatmap?.totals.totalTokens ?? 0)}
              {estimated && <small>{t("sidebar.tokenContainsEstimate")}</small>}
            </span>
            <span className="token-heatmap-legend" aria-hidden="true">
              <i className="level-0" /><i className="level-1" /><i className="level-2" />
              <i className="level-3" /><i className="level-4" />
            </span>
          </footer>
        </>
      )}
    </section>
  )
}
