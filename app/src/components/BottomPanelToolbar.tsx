import type { BottomPanelTab } from "../store"
import { useI18n, type TranslationKey } from "../i18n"
import {
  Building2Icon,
  ChevronDownIcon,
  DownloadIcon,
  FileTextIcon,
  HammerIcon,
  MonitorIcon,
  ShoppingBagIcon,
  TerminalIcon,
  Trash2Icon,
} from "./Icons"

export interface SerialPortInfo {
  port: string
  description: string
}

interface BottomPanelToolbarProps {
  activeTab: BottomPanelTab
  collapsed: boolean
  outputLength: number
  serialPorts: SerialPortInfo[]
  serialPortsLoading: boolean
  serialPort: string | null
  serialBaudRate: number
  serialConnected: boolean
  serialContextEnabled: boolean
  outputCount: (tab: BottomPanelTab) => number
  onSelectTab: (tab: BottomPanelTab) => void
  onToggleCollapsed: () => void
  onClear: (tab: BottomPanelTab) => void
  onRefreshPorts: () => void
  onSetSerialPort: (port: string | null) => void
  onSetSerialBaud: (baud: number) => void
  onSetSerialContextEnabled: (enabled: boolean) => void
  onConnectSerial: () => void
  onDisconnectSerial: () => void
  onManualCompile?: () => void
}

const TABS: Array<{
  id: BottomPanelTab
  labelKey: TranslationKey
  Icon: typeof TerminalIcon
}> = [
  { id: "terminal", labelKey: "bottom.terminal", Icon: TerminalIcon },
  { id: "serial", labelKey: "bottom.serial", Icon: MonitorIcon },
  { id: "build", labelKey: "bottom.build", Icon: HammerIcon },
  { id: "download", labelKey: "bottom.download", Icon: DownloadIcon },
  { id: "log", labelKey: "bottom.log", Icon: FileTextIcon },
  { id: "office", labelKey: "bottom.office", Icon: Building2Icon },
  { id: "store", labelKey: "bottom.store", Icon: ShoppingBagIcon },
]

const BAUD_RATES = [4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

export function BottomPanelToolbar({
  activeTab,
  collapsed,
  outputLength,
  serialPorts,
  serialPortsLoading,
  serialPort,
  serialBaudRate,
  serialConnected,
  serialContextEnabled,
  outputCount,
  onSelectTab,
  onToggleCollapsed,
  onClear,
  onRefreshPorts,
  onSetSerialPort,
  onSetSerialBaud,
  onSetSerialContextEnabled,
  onConnectSerial,
  onDisconnectSerial,
  onManualCompile,
}: BottomPanelToolbarProps) {
  const { t } = useI18n()

  return (
    <div className="bottom-tabs">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`bottom-tab ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => {
            onSelectTab(tab.id)
            if (collapsed) onToggleCollapsed()
          }}
        >
          <tab.Icon size={13} />
          {t(tab.labelKey)}
          {outputCount(tab.id) > 0 && activeTab === tab.id && (
            <span className="bottom-tab-badge">{outputCount(tab.id)}</span>
          )}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      {!collapsed && activeTab === "serial" && (
        <>
          <select
            className="serial-select"
            value={serialPort ?? ""}
            onChange={(event) => onSetSerialPort(event.target.value || null)}
            disabled={serialConnected}
            onFocus={onRefreshPorts}
          >
            <option value="">{t("bottom.selectSerial")}</option>
            {serialPorts.map((port) => (
              <option key={port.port} value={port.port}>
                {port.port} - {port.description}
              </option>
            ))}
          </select>
          <button
            className="serial-refresh-btn"
            onClick={onRefreshPorts}
            disabled={serialPortsLoading}
            title={t("bottom.refreshSerial")}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={serialPortsLoading ? "spin" : ""}
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <select
            className="serial-select"
            value={serialBaudRate}
            onChange={(event) => onSetSerialBaud(parseInt(event.target.value))}
            disabled={serialConnected}
          >
            {BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
          </select>
          <label
            className={`serial-ai-toggle ${serialContextEnabled ? "active" : ""}`}
            title={t("bottom.serialAiHint")}
          >
            <input
              type="checkbox"
              checked={serialContextEnabled}
              onChange={(event) => onSetSerialContextEnabled(event.target.checked)}
            />
            <span>{t("bottom.serialAi")}</span>
          </label>
          {!serialConnected ? (
            <button className="serial-connect-btn" onClick={onConnectSerial} disabled={!serialPort}>
              {t("bottom.connect")}
            </button>
          ) : (
            <button className="serial-disconnect-btn" onClick={onDisconnectSerial}>
              {t("bottom.disconnect")}
            </button>
          )}
          {serialConnected && <span className="serial-status-connected">● {t("common.connected")}</span>}
        </>
      )}
      {!collapsed && activeTab === "build" && onManualCompile && (
        <button
          className="bottom-tab build-compile-btn"
          onClick={onManualCompile}
          title={t("bottom.manualBuild")}
        >
          <HammerIcon size={12} />
          {t("bottom.build")}
        </button>
      )}
      {activeTab !== "office" && activeTab !== "store" && activeTab !== "download" && (
        <button
          className="bottom-tab"
          onClick={() => onClear(activeTab)}
          title={t("bottom.clear")}
          disabled={outputLength === 0}
        >
          <Trash2Icon size={13} />
        </button>
      )}
      <button
        className="bottom-panel-toggle"
        onClick={onToggleCollapsed}
        title={collapsed ? t("bottom.expand") : t("bottom.collapse")}
      >
        <ChevronDownIcon size={13} className={collapsed ? "expanded" : ""} />
      </button>
    </div>
  )
}
