import { useEffect, useRef, useState, useCallback } from "react"
import type { BottomPanelTab, LogLine } from "../store"
import { apiFetch } from "../api"
import type { AgentInfo } from "../types"
import { AgentOfficePanel } from "./AgentOfficePanel"
import { OfficeStorePanel } from "./OfficeStorePanel"
import { DownloadPanel } from "./DownloadPanel"
import { BottomPanelToolbar, type SerialPortInfo } from "./BottomPanelToolbar"
import { useI18n } from "../i18n"
interface BottomPanelProps {
  activeTab: BottomPanelTab
  terminalOutput: LogLine[]; serialOutput: LogLine[]; buildOutput: LogLine[]; agentLogOutput: LogLine[]
  activeSessionId: string | null
  agents: AgentInfo[]
  contextUsage: { used: number; total: number } | null
  isStreaming: boolean
  workspace: string | null
  height: number
  collapsed: boolean
  serialPort: string | null; serialBaudRate: number; serialConnected: boolean
  serialContextEnabled: boolean
  onSelectTab: (tab: BottomPanelTab) => void
  onToggleCollapsed: () => void
  onClear: (target: BottomPanelTab) => void
  onTerminalLog: (line: LogLine) => void; onSerialLog: (line: LogLine) => void
  onSetSerialPort: (port: string | null) => void
  onSetSerialBaud: (baud: number) => void
  onSetSerialConnected: (connected: boolean) => void
  onSetSerialContextEnabled: (enabled: boolean) => void
  onManualCompile?: () => void
  onOfficeSend: (text: string, scope?: "auto-edit" | "full-access", agentId?: string) => void
  onOfficeStop: () => void
  onOfficeCompact: () => void
}
export function BottomPanel({ activeTab, terminalOutput, serialOutput, buildOutput, agentLogOutput, activeSessionId, agents, contextUsage, isStreaming, workspace, height, collapsed, serialPort, serialBaudRate, serialConnected, serialContextEnabled, onSelectTab, onToggleCollapsed, onClear, onTerminalLog, onSerialLog, onSetSerialPort, onSetSerialBaud, onSetSerialConnected, onSetSerialContextEnabled, onManualCompile, onOfficeSend, onOfficeStop, onOfficeCompact }: BottomPanelProps) {
  const { t } = useI18n()
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const serialInputRef = useRef<HTMLInputElement>(null)
  const [cmd, setCmd] = useState("")
  const [running, setRunning] = useState(false)
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([])
  const [serialInput, setSerialInput] = useState("")
  const [serialPortsLoading, setSerialPortsLoading] = useState(false)
  const serialAbortRef = useRef<AbortController | null>(null)
  const cmdRef = useRef(cmd)
  const runningRef = useRef(running)
  cmdRef.current = cmd
  runningRef.current = running
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }) }, [terminalOutput, serialOutput, buildOutput, agentLogOutput])
  // 加载串口列表（可手动调用刷新）
  const refreshPorts = useCallback(async () => {
    setSerialPortsLoading(true)
    try {
      const r = await apiFetch("/api/serial/ports")
      const data = await r.json()
      if (Array.isArray(data.ports)) setSerialPorts(data.ports)
    } catch {}
    setSerialPortsLoading(false)
  }, [])
  // 串口 Tab 激活时加载端口列表
  useEffect(() => {
    if (activeTab !== "serial") return
    refreshPorts()
  }, [activeTab, refreshPorts])
  // 组件卸载时断开串口
  useEffect(() => {
    return () => { serialAbortRef.current?.abort() }
  }, [])
  const output = activeTab === "terminal" ? terminalOutput
    : activeTab === "serial" ? serialOutput
    : activeTab === "build" ? buildOutput
    : activeTab === "log" ? agentLogOutput : []
  const outputCount = (tab: BottomPanelTab) => tab === "terminal" ? terminalOutput.length
    : tab === "serial" ? serialOutput.length
    : tab === "build" ? buildOutput.length
    : tab === "log" ? agentLogOutput.length : 0
  const execCommand = useCallback(async () => {
    const trimmed = cmdRef.current.trim()
    if (!trimmed || runningRef.current) return
    setRunning(true)
    setCmd("")
    onTerminalLog({ text: `> ${trimmed}`, type: "info", timestamp: Date.now() })
    try {
      const resp = await apiFetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed, cwd: workspace ?? undefined }),
      })
      if (!resp.ok) throw new Error(await responseError(resp))
      const reader = resp.body?.getReader()
      if (!reader) { setRunning(false); return }
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6))
              onTerminalLog({ text: data.text, type: data.type === "stderr" ? "error" : data.type === "error" ? "error" : "info", timestamp: Date.now() })
            } catch {}
          }
        }
      }
    } catch (e: any) {
      onTerminalLog({ text: `连接错误: ${e.message}`, type: "error", timestamp: Date.now() })
    } finally {
      setRunning(false)
      inputRef.current?.focus()
    }
  }, [workspace])
  // 串口连接
  const connectSerial = useCallback(async () => {
    if (!serialPort || serialConnected) return
    onSetSerialConnected(true)
    onSerialLog({ text: `[连接 ${serialPort} @ ${serialBaudRate}bps]`, type: "info", timestamp: Date.now() })
    const abort = new AbortController()
    serialAbortRef.current = abort
    try {
      const resp = await apiFetch("/api/serial/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: serialPort, baudRate: serialBaudRate }),
        signal: abort.signal,
      })
      if (!resp.ok) throw new Error(await responseError(resp))
      const reader = resp.body?.getReader()
      if (!reader) { onSetSerialConnected(false); return }
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6))
              onSerialLog({ text: data.text, type: data.type === "error" ? "error" : "info", timestamp: Date.now() })
            } catch {}
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        onSerialLog({ text: `串口错误: ${e.message}`, type: "error", timestamp: Date.now() })
      }
    } finally {
      onSetSerialConnected(false)
      serialAbortRef.current = null
    }
  }, [serialPort, serialBaudRate, serialConnected, onSerialLog, onSetSerialConnected])
  // 串口断开
  const disconnectSerial = useCallback(() => {
    serialAbortRef.current?.abort()
    onSetSerialConnected(false)
    onSerialLog({ text: "[已断开]", type: "info", timestamp: Date.now() })
  }, [onSerialLog, onSetSerialConnected])
  // 串口发送
  const sendSerial = useCallback(async () => {
    const data = serialInput.trim()
    if (!data || !serialPort) return
    onSerialLog({ text: `> ${data}`, type: "success", timestamp: Date.now() })
    setSerialInput("")
    try {
      const response = await apiFetch("/api/serial/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: serialPort, baudRate: serialBaudRate, data }),
      })
      if (!response.ok) throw new Error(await responseError(response))
    } catch (e: any) {
      onSerialLog({ text: `发送失败: ${e.message}`, type: "error", timestamp: Date.now() })
    }
    serialInputRef.current?.focus()
  }, [serialInput, serialPort, serialBaudRate, onSerialLog])
  const focusInput = () => { if (activeTab === "terminal") inputRef.current?.focus() }
  return (
    <div className={`bottom-panel ${collapsed ? "collapsed" : ""}`} style={{ height: collapsed ? 32 : height }}>
      <BottomPanelToolbar
        activeTab={activeTab}
        collapsed={collapsed}
        outputLength={output.length}
        serialPorts={serialPorts}
        serialPortsLoading={serialPortsLoading}
        serialPort={serialPort}
        serialBaudRate={serialBaudRate}
        serialConnected={serialConnected}
        serialContextEnabled={serialContextEnabled}
        outputCount={outputCount}
        onSelectTab={onSelectTab}
        onToggleCollapsed={onToggleCollapsed}
        onClear={onClear}
        onRefreshPorts={refreshPorts}
        onSetSerialPort={onSetSerialPort}
        onSetSerialBaud={onSetSerialBaud}
        onSetSerialContextEnabled={onSetSerialContextEnabled}
        onConnectSerial={connectSerial}
        onDisconnectSerial={disconnectSerial}
        onManualCompile={onManualCompile}
      />
      <div
        className={`bottom-content bottom-content-${activeTab} ${activeTab === "office" ? "office-content" : activeTab === "store" ? "store-content" : activeTab === "download" ? "download-content" : ""}`}
        onClick={focusInput}
      >
        <div className={`office-runtime-keepalive ${activeTab === "office" ? "active" : ""}`} aria-hidden={activeTab !== "office"}>
          <AgentOfficePanel activeSessionId={activeSessionId} agents={agents} contextUsage={contextUsage} isStreaming={isStreaming} onSend={onOfficeSend} onStop={onOfficeStop} onCompact={onOfficeCompact} />
        </div>
        {activeTab === "office" ? null : activeTab === "store" ? (
          <OfficeStorePanel onOpenOffice={() => onSelectTab("office")} />
        ) : activeTab === "download" ? (
          <DownloadPanel
            active
            workspace={workspace}
            sessionId={activeSessionId}
          />
        ) : <>
        {output.length === 0 && activeTab !== "terminal" && (
          <span style={{ color: "var(--text-tertiary)" }}>
            {activeTab === "serial" && t("bottom.noSerial")}
            {activeTab === "build" && t("bottom.noBuild")}
            {activeTab === "log" && (activeSessionId ? t("bottom.noAgentLog") : t("bottom.selectSessionForLog"))}
          </span>
        )}
        {output.map((line, i) => (
          <span key={i} className={`bottom-line ${line.type}`}>
            {(line.type === "timestamp" || activeTab === "log") && (
              <span className="bottom-line-time">[{new Date(line.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}] </span>
            )}
            {line.text}
          </span>
        ))}
        {/* 终端输入行 */}
        {activeTab === "terminal" && (
          <div className="terminal-input-row">
            <span className="terminal-prompt">&gt;</span>
            <input
              ref={inputRef}
              className="terminal-input"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") execCommand() }}
              placeholder={running ? t("bottom.running") : t("bottom.shellPlaceholder")}
              disabled={running}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {/* 串口发送输入行 */}
        {activeTab === "serial" && serialConnected && (
          <div className="serial-input-row">
            <span className="serial-prompt">&gt;</span>
            <input
              ref={serialInputRef}
              className="serial-input"
              value={serialInput}
              onChange={(e) => setSerialInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendSerial() }}
              placeholder={t("bottom.serialPlaceholder")}
              spellCheck={false}
              autoComplete="off"
            />
            <button className="serial-send-btn" onClick={sendSerial}>{t("common.send")}</button>
          </div>
        )}
        <div ref={bottomRef} />
        </>}
      </div>
    </div>
  )
}

async function responseError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 1_000)
  try {
    const data = JSON.parse(text) as { error?: unknown }
    if (typeof data.error === "string" && data.error) return data.error
  } catch {}
  return text || `HTTP ${response.status}`
}
