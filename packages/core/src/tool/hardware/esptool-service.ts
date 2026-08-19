import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { loadLatestSuccessfulBuildManifest } from "./build-manifest"
import type { ProgrammingBundle } from "./build-types"
import { serialList } from "./serial-port"
import { runProcess, type ProcessResult } from "../process"
import { findProjectRoot } from "../../store/project-config"
import { loadProjectConfig } from "../../store/project-config"
import { assertEspBuildContract, type EspBuildTarget } from "../../runtime/esp-build-scope"

export interface EspToolInstallation {
  command: string[]
  displayCommand: string
  version?: string
}

export interface EspDownloadPort {
  port: string
  description: string
  transport: "usb-native" | "usb-uart" | "uart"
}

export interface EspToolStatus {
  provider: "esptool"
  installation: EspToolInstallation | null
  ports: EspDownloadPort[]
  bundle: ProgrammingBundle | null
  canFlash: boolean
  blockers: string[]
  installer: {
    automaticInstallSupported: boolean
    package: "esptool"
    requiresConfirmation: true
  }
}

export interface EspConnectionResult {
  connected: true
  port: string
  configuredTarget: string
  detectedChip: string
  transport: EspDownloadPort["transport"]
}

export interface EspFlashResult {
  success: true
  verified: true
  verificationEvidence: string
  exitCode: number
  bundleId: string
  chip: string
  port: string
  programmedBytes: number
  connection: EspConnectionResult
}

const ESP_BAUD_RATES = new Set([115200, 230400, 460800, 921600, 1_500_000, 2_000_000])
let discovery: Promise<EspToolInstallation | null> | undefined

export async function getEspToolStatus(
  projectRoot: string,
  options: { detectPorts?: boolean } = {},
): Promise<EspToolStatus> {
  resolveEspDownloadTarget(projectRoot)
  const [installation, ports] = await Promise.all([
    discoverEsptool(),
    Promise.resolve(options.detectPorts === false ? [] : discoverEspPorts()),
  ])
  const bundle = loadCertifiedEspBundle(projectRoot)
  const blockers: string[] = []
  if (!installation) blockers.push("未找到 esptool；可在下载页确认后自动安装")
  if (!bundle) blockers.push("最近一次 ESP-IDF 构建没有经过认证的多 BIN 下载清单")
  if (options.detectPorts === false) blockers.push("尚未检测 ESP 下载端口")
  else if (ports.length === 0) blockers.push("未检测到 USB Serial/JTAG、USB CDC 或 UART 下载端口")
  return {
    provider: "esptool",
    installation,
    ports,
    bundle,
    canFlash: blockers.length === 0,
    blockers,
    installer: {
      automaticInstallSupported: Boolean(await discoverPython()),
      package: "esptool",
      requiresConfirmation: true,
    },
  }
}

/** The Download tab and the Agent flash tool share this non-bypassable scope gate. */
export function resolveEspDownloadTarget(projectRoot: string): EspBuildTarget {
  const root = resolve(findProjectRoot(projectRoot) ?? projectRoot)
  const config = loadProjectConfig(root)
  return assertEspBuildContract({
    projectRoot: root,
    chipModel: config.project.target_confirmed ? config.project.chip : undefined,
    buildSystem: config.build.build_system,
    platformTarget: config.build.platform_target,
  })
}

export async function discoverEsptool(force = false): Promise<EspToolInstallation | null> {
  if (!force && discovery) return discovery
  discovery = discoverEsptoolUncached()
  return discovery
}

async function discoverEsptoolUncached(): Promise<EspToolInstallation | null> {
  const candidates: string[][] = []
  if (process.env.ESPTOOL) candidates.push([process.env.ESPTOOL])
  candidates.push(["esptool"], ["esptool.py"])
  const python = await discoverPython()
  if (python) candidates.push([...python, "-m", "esptool"])
  for (const command of candidates) {
    try {
      const result = await runProcess([...command, "--version"], { timeoutMs: 8_000, maxOutputChars: 20_000 })
      const output = `${result.stdout}\n${result.stderr}`
      if (result.exitCode !== 0 || !/esptool(?:\.py)?\s+v?[0-9]/i.test(output)) continue
      return {
        command,
        displayCommand: command.join(" "),
        version: output.match(/esptool(?:\.py)?\s+v?([0-9][^\s]*)/i)?.[1],
      }
    } catch {}
  }
  return null
}

export function discoverEspPorts(): EspDownloadPort[] {
  const result = serialList()
  if (!result.success) return []
  const response = result.data as { data?: { ports?: unknown[] }; ports?: unknown[] } | undefined
  const ports = response?.data?.ports ?? response?.ports ?? []
  return ports.flatMap((value) => {
    const item = value as { port?: unknown; description?: unknown }
    if (typeof item.port !== "string" || !item.port.trim()) return []
    const description = typeof item.description === "string" ? item.description : ""
    return [{
      port: item.port,
      description,
      transport: classifyEspTransport(description),
    }]
  })
}

export function classifyEspTransport(description: string): EspDownloadPort["transport"] {
  if (/serial.?jtag|usb.?jtag|usb.?cdc|espressif/i.test(description)) return "usb-native"
  if (/usb/i.test(description)) return "usb-uart"
  return "uart"
}

export async function connectEspTarget(input: {
  projectRoot: string
  port: string
  expectedChip?: string
  signal?: AbortSignal
  onLine?: (line: string, type: "stdout" | "stderr") => void
}): Promise<EspConnectionResult> {
  resolveEspDownloadTarget(input.projectRoot)
  const installation = await discoverEsptool(true)
  if (!installation) throw new Error("未找到可用的 esptool")
  const port = requirePort(input.port)
  const bundle = loadCertifiedEspBundle(input.projectRoot)
  const expected = normalizeEspChip(input.expectedChip ?? bundle?.chip ?? "")
  if (!expected) throw new Error("项目没有经过认证的 ESP-IDF 芯片 target")
  const result = await runProcess([
    ...installation.command,
    "--chip", expected,
    "--port", port,
    "chip-id",
  ], {
    signal: input.signal,
    timeoutMs: 30_000,
    maxOutputChars: 100_000,
    onLine: input.onLine,
  })
  assertProcessSucceeded(result, "esptool 芯片识别")
  const output = `${result.stdout}\n${result.stderr}`
  const detected = parseDetectedEspChip(output)
  if (!detected) throw new Error("esptool 已连接，但未返回可验证的芯片型号")
  assertEspChipMatch(detected, expected)
  const found = discoverEspPorts().find((item) => item.port.toLowerCase() === port.toLowerCase())
  return {
    connected: true,
    port,
    configuredTarget: expected,
    detectedChip: detected,
    transport: found?.transport ?? "uart",
  }
}

export async function flashEspBundle(input: {
  projectRoot: string
  port: string
  baud?: number
  bundleId?: string
  verify?: boolean
  signal?: AbortSignal
  onLine?: (line: string, type: "stdout" | "stderr") => void
}): Promise<EspFlashResult> {
  resolveEspDownloadTarget(input.projectRoot)
  const installation = await discoverEsptool(true)
  if (!installation) throw new Error("未找到可用的 esptool")
  const bundle = loadCertifiedEspBundle(input.projectRoot)
  if (!bundle) throw new Error("没有可下载的 ESP-IDF 认证固件包")
  if (input.bundleId && input.bundleId !== bundle.bundleId) throw new Error("下载固件包已过期，请刷新后重试")
  const baud = input.baud ?? 460800
  if (!ESP_BAUD_RATES.has(baud)) throw new Error("ESP 下载波特率不在允许范围内")
  const connection = await connectEspTarget({
    projectRoot: input.projectRoot,
    port: input.port,
    expectedChip: bundle.chip,
    signal: input.signal,
    onLine: input.onLine,
  })
  const commands = buildEspFlashCommands(installation, bundle, connection.port, baud)
  const write = await runProcess(commands.write, {
    signal: input.signal,
    timeoutMs: 300_000,
    maxOutputChars: 300_000,
    onLine: input.onLine,
  })
  assertProcessSucceeded(write, "esptool 下载")
  if (input.verify === false) throw new Error("ESP 下载必须启用读回校验")
  const verify = await runProcess(commands.verify, {
    signal: input.signal,
    timeoutMs: 300_000,
    maxOutputChars: 300_000,
    onLine: input.onLine,
  })
  assertProcessSucceeded(verify, "esptool 校验")
  const verificationOutput = `${verify.stdout}\n${verify.stderr}`
  if (!/verify(?:ing|ied)|contents are the same|hash of data verified/i.test(verificationOutput)) {
    throw new Error("esptool 未返回可确认的 Flash 校验证据")
  }
  return {
    success: true,
    verified: true,
    verificationEvidence: "esptool 已对全部 ESP-IDF 镜像执行 Flash 读回校验",
    exitCode: verify.exitCode,
    bundleId: bundle.bundleId,
    chip: bundle.chip,
    port: connection.port,
    programmedBytes: bundle.images.reduce((sum, image) => sum + image.fileBytes, 0),
    connection,
  }
}

export function buildEspFlashCommands(
  installation: EspToolInstallation,
  bundle: ProgrammingBundle,
  port: string,
  baud: number,
): { write: string[]; verify: string[] } {
  const imageArguments = bundle.images.flatMap((image) => [`0x${image.offset.toString(16)}`, image.path])
  const settings = [
    ...(bundle.flashSettings.flashMode ? ["--flash-mode", bundle.flashSettings.flashMode] : []),
    ...(bundle.flashSettings.flashFreq ? ["--flash-freq", bundle.flashSettings.flashFreq] : []),
    ...(bundle.flashSettings.flashSize ? ["--flash-size", bundle.flashSettings.flashSize] : []),
  ]
  const base = [
    ...installation.command,
    "--chip", bundle.chip,
    "--port", port,
    "--baud", String(baud),
  ]
  return {
    write: [
      ...base,
      "--before", "default-reset",
      "--after", "hard-reset",
      "write-flash",
      ...settings,
      ...imageArguments,
    ],
    verify: [...base, "verify-flash", ...settings, ...imageArguments],
  }
}

export function parseDetectedEspChip(output: string): string {
  return normalizeEspChip(output.match(/Chip is\s+([A-Za-z0-9-]+)/i)?.[1] ?? "")
}

export function assertEspChipMatch(detected: string, expected: string): void {
  const actual = normalizeEspChip(detected)
  const target = normalizeEspChip(expected)
  if (!actual || !target || actual !== target) {
    throw new Error(`连接芯片 ${actual || "未知"} 与项目目标 ${target || "未知"} 不一致`)
  }
}

export async function installEsptool(options: {
  signal?: AbortSignal
  onLine?: (line: string, type: "stdout" | "stderr") => void
} = {}): Promise<EspToolInstallation> {
  const python = await discoverPython()
  if (!python) throw new Error("未找到 Python，无法自动安装 esptool")
  const result = await runProcess([...python, "-m", "pip", "install", "--user", "esptool"], {
    signal: options.signal,
    timeoutMs: 600_000,
    maxOutputChars: 300_000,
    onLine: options.onLine,
  })
  assertProcessSucceeded(result, "esptool 安装")
  const installed = await discoverEsptool(true)
  if (!installed) throw new Error("pip 已结束，但仍无法运行 esptool")
  return installed
}

export function loadCertifiedEspBundle(projectRoot: string): ProgrammingBundle | null {
  const root = resolve(findProjectRoot(projectRoot) ?? projectRoot)
  const manifest = loadLatestSuccessfulBuildManifest(root)
  const bundle = manifest?.programming
  if (!manifest || !bundle || manifest.download.provider !== "esptool" || !manifest.download.eligible) return null
  if (manifest.download.bundleId !== bundle.bundleId) return null
  for (const image of bundle.images) {
    const path = resolve(root, image.path)
    const rel = relative(root, path)
    if (rel.startsWith("..") || resolve(root, rel) !== path || !existsSync(path)) return null
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex")
    if (sha256 !== image.sha256) return null
  }
  return bundle
}

async function discoverPython(): Promise<string[] | null> {
  const candidates = process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]]
  for (const command of candidates) {
    try {
      const result = await runProcess([...command, "--version"], { timeoutMs: 5_000, maxOutputChars: 10_000 })
      if (result.exitCode === 0 && /Python\s+3\./i.test(`${result.stdout}\n${result.stderr}`)) return command
    } catch {}
  }
  return null
}

function normalizeEspChip(value: string): string {
  return value.trim().toLowerCase().replace(/^esp32-?/, (prefix) => prefix.replace("-", "")).replace(/[^a-z0-9]/g, "")
}

function requirePort(value: string): string {
  const port = value.trim()
  if (!port || port.length > 260 || port.includes("\r") || port.includes("\n") || port.includes("\u0000")) {
    throw new Error("ESP 下载端口格式无效")
  }
  if (process.platform === "win32" && !/^COM\d+$/i.test(port)) throw new Error("Windows ESP 下载端口必须是 COM 端口")
  return port
}

function assertProcessSucceeded(result: ProcessResult, label: string): void {
  if (result.aborted) {
    const error = new Error(`${label}已取消`)
    error.name = "AbortError"
    throw error
  }
  if (result.timedOut) throw new Error(`${label}超时`)
  if (result.exitCode !== 0) {
    const details = `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-8).join("\n")
    throw new Error(details || `${label}失败，退出码 ${result.exitCode}`)
  }
}
