import { useI18n } from "../i18n"
import {
  AlertCircleIcon,
  CheckCircleIcon,
  DownloadIcon,
  RefreshCwIcon,
  UsbIcon,
  XIcon,
} from "./Icons"

export type EspTransport = "usb-native" | "usb-uart" | "uart"

export interface EspProgrammerStatus {
  provider: "esptool"
  installation: { command: string[]; displayCommand: string; version?: string } | null
  ports: Array<{ port: string; description: string; transport: EspTransport }>
  bundle: {
    bundleId: string
    chip: string
    images: Array<{
      path: string
      relativePath: string
      offset: number
      fileBytes: number
      sha256: string
    }>
  } | null
  canFlash: boolean
  blockers: string[]
  installer: {
    automaticInstallSupported: boolean
    package: "esptool"
    requiresConfirmation: true
  }
}

interface DownloadPanelViewProps {
  status: EspProgrammerStatus | null
  selectedPort: string
  baud: number
  loading: boolean
  flashing: boolean
  installing: boolean
  connected: boolean
  logs: string[]
  onDetect: () => void
  onCancel: () => void
  onFlash: () => void
  onInstall: () => void
  onSelectPort: (port: string) => void
  onSelectBaud: (baud: number) => void
}

export function DownloadPanelView({
  status,
  selectedPort,
  baud,
  loading,
  flashing,
  installing,
  connected,
  logs,
  onDetect,
  onCancel,
  onFlash,
  onInstall,
  onSelectPort,
  onSelectBaud,
}: DownloadPanelViewProps) {
  const { t } = useI18n()
  const port = status?.ports.find((item) => item.port === selectedPort)
  const ready = Boolean(status?.canFlash && status.bundle && port && connected)
  const totalBytes = status?.bundle?.images.reduce((sum, image) => sum + image.fileBytes, 0) ?? 0

  return (
    <div className="download-panel">
      <div className="download-toolbar">
        <div className="download-title"><DownloadIcon size={16} />{t("download.title")}</div>
        <button
          className="download-secondary"
          disabled={loading || flashing || installing}
          onClick={onDetect}
        >
          <RefreshCwIcon size={13} className={loading ? "spin" : ""} />
          {t("download.detect")}
        </button>
        {flashing || installing ? (
          <button className="download-danger" onClick={onCancel}>
            <XIcon size={13} />{t("download.cancel")}
          </button>
        ) : (
          <button className="download-primary" disabled={!ready} onClick={onFlash}>
            <DownloadIcon size={13} />{t("download.flash")}
          </button>
        )}
      </div>

      <div className="download-grid">
        <section className="download-card">
          <h4>{t("download.artifact")}</h4>
          {status?.bundle ? (
            <>
              <StatusLine
                ok
                text={`${status.bundle.chip} · ${status.bundle.images.length} BIN · ${formatBytes(totalBytes)}`}
              />
              <dl>
                {status.bundle.images.map((image) => (
                  <div key={`${image.offset}-${image.path}`}>
                    <dt>{`0x${image.offset.toString(16).toUpperCase()}`}</dt>
                    <dd title={image.sha256}>
                      {image.relativePath} · {formatBytes(image.fileBytes)}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : <p>{t("download.noEspBundle")}</p>}
        </section>

        <section className="download-card">
          <h4><UsbIcon size={14} />{t("download.programmer")}</h4>
          <StatusLine
            ok={Boolean(status?.installation)}
            text={status?.installation
              ? `esptool ${status.installation.version ?? ""}`
              : t("download.esptoolMissing")}
          />
          {!status?.installation && status?.installer.automaticInstallSupported && (
            <button
              className="download-secondary download-agent-action"
              disabled={installing}
              onClick={onInstall}
            >
              <DownloadIcon size={13} />{t("download.installEsp")}
            </button>
          )}
          <select value={selectedPort} onChange={(event) => onSelectPort(event.target.value)}>
            <option value="">{t("download.selectPort")}</option>
            {status?.ports.map((item) => (
              <option key={item.port} value={item.port}>
                {item.port} · {transportLabel(item.transport, t)}
                {item.description ? ` · ${item.description}` : ""}
              </option>
            ))}
          </select>
          <select value={baud} onChange={(event) => onSelectBaud(Number(event.target.value))}>
            {[115200, 230400, 460800, 921600, 1500000, 2000000].map((value) => (
              <option key={value} value={value}>{value} baud</option>
            ))}
          </select>
          <StatusLine
            ok={Boolean(status?.ports.length)}
            text={port
              ? `${transportLabel(port.transport, t)} · ${port.port}`
              : t("download.espPortMissing")}
          />
          {connected && <StatusLine ok text={t("download.connectionVerified")} />}
        </section>

        <section className="download-card download-status-card">
          <h4>{t("download.readiness")}</h4>
          {status?.blockers.map((blocker) => <StatusLine key={blocker} ok={false} text={blocker} />)}
          {!connected && status?.ports.length
            ? <StatusLine ok={false} text={t("download.connectRequired")} />
            : null}
          {ready && <StatusLine ok text={t("download.ready")} />}
        </section>
      </div>
      <div className="download-log" aria-live="polite">
        {logs.length === 0
          ? t("download.logHint")
          : logs.map((line, index) => <div key={index}>{line}</div>)}
      </div>
    </div>
  )
}

function StatusLine({ ok, text }: { ok: boolean; text: string }) {
  const Icon = ok ? CheckCircleIcon : AlertCircleIcon
  return (
    <div className={`download-status ${ok ? "ok" : "blocked"}`}>
      <Icon size={13} />
      <span>{text}</span>
    </div>
  )
}

export function transportLabel(
  transport: EspTransport,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (transport === "usb-native") return t("download.transportUsbNative")
  if (transport === "usb-uart") return t("download.transportUsbUart")
  return t("download.transportUart")
}

function formatBytes(value: number) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`
}
