import { useCallback, useEffect, useRef, useState } from "react"
import { apiFetch } from "../api"
import { useI18n } from "../i18n"
import { appendDownloadLog } from "../download-log"
import {
  DownloadPanelView,
  transportLabel,
  type EspProgrammerStatus,
  type EspTransport,
} from "./DownloadPanelView"

interface DownloadPanelProps {
  active: boolean
  workspace: string | null
  sessionId: string | null
}

export function DownloadPanel({ active, workspace, sessionId }: DownloadPanelProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<EspProgrammerStatus | null>(null)
  const [selectedPort, setSelectedPort] = useState("")
  const [baud, setBaud] = useState(460800)
  const [loading, setLoading] = useState(false)
  const [flashing, setFlashing] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [connected, setConnected] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const appendLog = useCallback((line: string) => {
    setLogs((current) => appendDownloadLog(current, line))
  }, [])

  const refresh = useCallback(async () => {
    if (!workspace) return undefined
    setLoading(true)
    try {
      const response = await apiFetch(
        `/api/programmer/status?projectDir=${encodeURIComponent(workspace)}&ports=1`,
      )
      if (!response.ok) throw new Error(await responseError(response))
      const next = await response.json() as EspProgrammerStatus
      setStatus(next)
      setSelectedPort((current) => next.ports.some((item) => item.port === current)
        ? current
        : next.ports[0]?.port ?? "")
      return next
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setStatus(null)
      appendLog(text)
      return undefined
    } finally {
      setLoading(false)
    }
  }, [appendLog, workspace])

  const detectAndConnect = useCallback(async () => {
    setConnected(false)
    const next = await refresh()
    const port = next?.ports.find((item) => item.port === selectedPort)?.port
      ?? next?.ports[0]?.port
    if (!workspace || !port) return
    setLoading(true)
    try {
      const response = await apiFetch("/api/programmer/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectDir: workspace, port }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const data = await response.json() as {
        result: {
          configuredTarget: string
          detectedChip: string
          transport: EspTransport
        }
      }
      setSelectedPort(port)
      appendLog(
        `${t("download.connected")}: ${data.result.detectedChip} · ${transportLabel(data.result.transport, t)}`,
      )
      setConnected(true)
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [appendLog, refresh, selectedPort, t, workspace])

  useEffect(() => {
    if (!active || !workspace) return
    setConnected(false)
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => window.clearInterval(timer)
  }, [active, workspace, refresh])

  useEffect(() => () => abortRef.current?.abort(), [])

  const flash = useCallback(async () => {
    if (!workspace || !status?.bundle || !selectedPort || !connected) return
    const firmwareName = `${status.bundle.chip} (${status.bundle.images.length} BIN)`
    if (!window.confirm(t("download.confirmFlash").replace("{name}", firmwareName))) return
    setFlashing(true)
    setLogs([])
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const response = await apiFetch("/api/programmer/flash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectDir: workspace,
          port: selectedPort,
          baud,
          bundleId: status.bundle.bundleId,
          sessionId,
          verify: true,
          confirmed: true,
        }),
        signal: abort.signal,
      })
      if (!response.ok) throw new Error(await responseError(response))
      await consumeEvents(response, appendLog)
      await refresh()
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        appendLog(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setFlashing(false)
      abortRef.current = null
    }
  }, [appendLog, baud, connected, refresh, selectedPort, sessionId, status, t, workspace])

  const installEspTool = useCallback(async () => {
    if (!workspace || !status?.installer.automaticInstallSupported) return
    if (!window.confirm(t("download.confirmInstallEsp"))) return
    setInstalling(true)
    setLogs([])
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const response = await apiFetch("/api/programmer/install-esptool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectDir: workspace, confirmed: true, sessionId }),
        signal: abort.signal,
      })
      if (!response.ok) throw new Error(await responseError(response))
      await consumeEvents(response, appendLog)
      await refresh()
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        appendLog(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setInstalling(false)
      abortRef.current = null
    }
  }, [appendLog, refresh, sessionId, status, t, workspace])

  if (!workspace) return <div className="download-empty">{t("download.noWorkspace")}</div>

  return (
    <DownloadPanelView
      status={status}
      selectedPort={selectedPort}
      baud={baud}
      loading={loading}
      flashing={flashing}
      installing={installing}
      connected={connected}
      logs={logs}
      onDetect={detectAndConnect}
      onCancel={() => abortRef.current?.abort()}
      onFlash={flash}
      onInstall={installEspTool}
      onSelectPort={(port) => {
        setSelectedPort(port)
        setConnected(false)
      }}
      onSelectBaud={setBaud}
    />
  )
}

async function consumeEvents(response: Response, append: (line: string) => void) {
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ""
  let completed = false
  let failure = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split("\n\n")
    buffer = chunks.pop() ?? ""
    for (const chunk of chunks) {
      const raw = chunk.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      if (!raw) continue
      const event = JSON.parse(raw) as {
        event: string
        text?: string
        error?: string
        result?: { verificationEvidence?: string }
      }
      append(event.text ?? event.error ?? (event.event === "complete"
        ? event.result?.verificationEvidence ?? "ESP 下载及校验完成"
        : event.event))
      if (event.event === "complete") completed = true
      if (event.event === "error" || event.event === "cancelled") failure = event.error ?? event.event
    }
  }
  if (failure) throw new Error(failure)
  if (!completed) throw new Error("操作连接已结束，但没有收到完成状态")
}

async function responseError(response: Response) {
  const data = await response.json().catch(() => ({})) as { error?: string }
  return data.error ?? `HTTP ${response.status}`
}
