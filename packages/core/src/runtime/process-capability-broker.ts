import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { findProjectRoot } from "../store/project-config.ts"

export type ProcessCapability =
  | "diagnostic"
  | "general-process"
  | "opaque-process"
  | "embedded-build"
  | "network"
  | "hardware"

export interface ProcessCapabilityFinding {
  capability: ProcessCapability
  executable: string
  targetDir: string
  reason: string
}

export interface ProcessCapabilityDecision {
  allowed: boolean
  findings: ProcessCapabilityFinding[]
  reason?: string
  projectRoot?: string
}

const DIRECT_EMBEDDED_BUILD_DRIVERS = new Set([
  "idf.py",
  "make",
  "mingw32-make",
  "ninja",
  "platformio",
  "pio",
  "scons",
  "west",
])

const OPAQUE_WRAPPERS = new Set([
  "bash",
  "bun",
  "bunx",
  "cmd",
  "cmd.exe",
  "node",
  "npx",
  "npm",
  "pnpm",
  "powershell",
  "powershell.exe",
  "pwsh",
  "python",
  "python3",
  "sh",
  "yarn",
])

const NESTED_SHELL_WRAPPERS = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "sh",
])

const DIAGNOSTIC_EXECUTABLES = new Set([
  "certutil",
  "dir",
  "echo",
  "find",
  "findstr",
  "git",
  "ls",
  "pwd",
  "rg",
  "type",
  "where",
  "where.exe",
])

const NETWORK_EXECUTABLES = new Set([
  "curl",
  "curl.exe",
  "ftp",
  "ftp.exe",
  "nslookup",
  "nslookup.exe",
  "ping",
  "ping.exe",
  "scp",
  "scp.exe",
  "sftp",
  "sftp.exe",
  "ssh",
  "ssh.exe",
  "wget",
  "wget.exe",
])

const HARDWARE_EXECUTABLES = new Set([
  "avrdude",
  "avrdude.exe",
  "bossac",
  "bossac.exe",
  "dfu-util",
  "dfu-util.exe",
  "esptool",
  "esptool.exe",
  "esptool.py",
  "jlink",
  "jlink.exe",
  "jlinkcommander",
  "jlinkcommander.exe",
  "openocd",
  "openocd.exe",
  "pyocd",
  "pyocd.exe",
  "st-flash",
  "st-flash.exe",
])

/**
 * Generic shell execution and embedded compilation are different host
 * capabilities. This broker is the single pre-spawn boundary for the shell
 * tool:
 *
 * - compiler/build drivers never execute through the generic shell;
 * - nested shells are recursively inspected, and opaque encodings fail closed;
 * - explicit compiler/build drivers and hardware executables remain behind
 *   their purpose-built tools;
 * - ordinary processes, scripts and network commands are authorized by the
 *   runtime tool policy before this pre-spawn boundary is reached. A project
 *   type must not silently revoke user-granted terminal authority.
 *
 * This is executable-identity enforcement, not natural-language intent
 * matching. The model cannot change the decision by rephrasing its request.
 */
export function authorizeShellProcess(
  command: string,
  cwd: string,
): ProcessCapabilityDecision {
  const findings = inspectShellCommand(command, resolve(cwd))
  const build = findings.find((finding) => finding.capability === "embedded-build")
  if (build) {
    return {
      allowed: false,
      findings,
      reason: "嵌入式构建只能通过 compile 工具的结构化 ESP-IDF 执行器运行；通用 shell 不具备编译能力。",
      projectRoot: managedProjectRoot(build.targetDir),
    }
  }
  const hardware = findings.find((finding) => finding.capability === "hardware")
  if (hardware) {
    return {
      allowed: false,
      findings,
      reason: "硬件、烧录和调试操作只能通过具名硬件工具执行；通用 shell 不具备该能力。",
      projectRoot: managedProjectRoot(hardware.targetDir),
    }
  }
  const nestedShell = findings.find((finding) =>
    finding.capability === "opaque-process"
    && NESTED_SHELL_WRAPPERS.has(finding.executable.toLowerCase()))
  if (nestedShell) {
    return {
      allowed: false,
      findings,
      reason: "通用 shell 已提供当前平台的命令解释器；禁止再嵌套其他 shell 或编码命令绕过执行前审计。",
      projectRoot: managedProjectRoot(nestedShell.targetDir),
    }
  }

  const managed = findings
    .map((finding) => managedProjectRoot(finding.targetDir))
    .find((root): root is string => Boolean(root))
    ?? managedProjectRoot(cwd)
  return { allowed: true, findings, projectRoot: managed }
}

export function inspectShellCommand(
  command: string,
  initialCwd: string,
  depth = 0,
): ProcessCapabilityFinding[] {
  if (depth > 4) {
    return [finding("opaque-process", "nested-shell", initialCwd, "包装器递归深度超过安全上限")]
  }
  const findings: ProcessCapabilityFinding[] = []
  let cwd = initialCwd
  for (const segment of splitShellSegments(command)) {
    const tokens = tokenize(segment)
    if (tokens.length === 0) continue
    if (tokens[0]?.toLowerCase() === "call") tokens.shift()
    while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[0])) tokens.shift()
    if (tokens.length === 0) continue
    if (tokens[0]?.toLowerCase() === "cd") {
      const target = tokens.find((token, index) => index > 0 && token.toLowerCase() !== "/d")
      if (target) cwd = resolveAgainst(cwd, target)
      continue
    }
    findings.push(...inspectInvocation(tokens, cwd, depth))
  }
  return findings.length > 0
    ? findings
    : [finding("diagnostic", "shell-noop", initialCwd, "命令不产生子进程")]
}

function inspectInvocation(
  tokens: string[],
  cwd: string,
  depth: number,
): ProcessCapabilityFinding[] {
  const executable = executableName(tokens[0]!)
  const lower = executable.toLowerCase()
  const args = tokens.slice(1)

  if (lower === "cmd" || lower === "cmd.exe") {
    const commandIndex = args.findIndex((arg) => /^\/[ck]$/i.test(arg))
    if (commandIndex < 0 || commandIndex === args.length - 1) {
      return [finding("opaque-process", executable, cwd, "cmd 包装器未提供可审计的命令")]
    }
    return [
      finding("opaque-process", executable, cwd, "嵌套 cmd 可改变外层命令的进程边界"),
      ...inspectShellCommand(args.slice(commandIndex + 1).join(" "), cwd, depth + 1),
    ]
  }
  if (lower === "powershell" || lower === "powershell.exe" || lower === "pwsh") {
    const encoded = args.some((arg) => /^-(?:e|enc|encodedcommand)$/i.test(arg))
    if (encoded) {
      return [finding("opaque-process", executable, cwd, "编码 PowerShell 命令无法在执行前审计")]
    }
    const commandIndex = args.findIndex((arg) => /^-(?:c|command)$/i.test(arg))
    if (commandIndex < 0 || commandIndex === args.length - 1) {
      return [finding("opaque-process", executable, cwd, "PowerShell 包装器未提供可审计的命令")]
    }
    return [
      finding("opaque-process", executable, cwd, "嵌套 PowerShell 可改变外层命令的进程边界"),
      ...inspectShellCommand(args.slice(commandIndex + 1).join(" "), cwd, depth + 1),
    ]
  }
  if (lower === "sh" || lower === "bash") {
    const commandIndex = args.findIndex((arg) => arg === "-c" || arg === "-lc")
    if (commandIndex < 0 || commandIndex === args.length - 1) {
      return [finding("opaque-process", executable, cwd, "shell 包装器未提供可审计的命令")]
    }
    return [
      finding("opaque-process", executable, cwd, "嵌套 shell 可改变外层命令的进程边界"),
      ...inspectShellCommand(args.slice(commandIndex + 1).join(" "), cwd, depth + 1),
    ]
  }

  const targetDir = buildTargetDir(lower, args, cwd)
  if (isEmbeddedBuildDriver(lower, args)) {
    return [finding("embedded-build", executable, targetDir, "命令启动编译器或嵌入式构建驱动")]
  }
  if (NETWORK_EXECUTABLES.has(lower)) {
    return [finding("network", executable, targetDir, "命令启动网络访问进程")]
  }
  if (HARDWARE_EXECUTABLES.has(lower)) {
    return [finding("hardware", executable, targetDir, "命令访问硬件或调试接口")]
  }
  if (OPAQUE_WRAPPERS.has(lower) || isScriptFile(lower)) {
    return [finding("opaque-process", executable, targetDir, "命令可在审计边界之外启动任意子进程")]
  }
  if (isDiagnostic(lower, args)) {
    return [finding("diagnostic", executable, targetDir, "命令属于只读诊断能力")]
  }
  return [finding("general-process", executable, targetDir, "命令启动未声明能力的通用进程")]
}

function isEmbeddedBuildDriver(executable: string, args: string[]): boolean {
  if (DIRECT_EMBEDDED_BUILD_DRIVERS.has(executable)) return true
  if (executable === "cmake") {
    return args.some((arg) => ["--build", "-s", "-b"].includes(arg.toLowerCase()))
  }
  return /^(?:arm-none-eabi-|riscv(?:32|64)?-[a-z0-9-]*|xtensa-[a-z0-9-]*)?(?:gcc|g\+\+|cc|c\+\+|clang|clang\+\+)(?:\.exe)?$/i
    .test(executable)
}

function buildTargetDir(executable: string, args: string[], cwd: string): string {
  if (executable === "make" || executable === "mingw32-make") {
    const index = args.findIndex((arg) => arg === "-C" || arg === "-c")
    if (index >= 0 && args[index + 1]) return resolveAgainst(cwd, args[index + 1]!)
  }
  if (executable === "cmake") {
    const index = args.findIndex((arg) => arg === "-S" || arg === "-s")
    if (index >= 0 && args[index + 1]) return resolveAgainst(cwd, args[index + 1]!)
  }
  return cwd
}

function isDiagnostic(executable: string, args: string[]): boolean {
  if (!DIAGNOSTIC_EXECUTABLES.has(executable)) return false
  if (executable === "git") {
    return ["diff", "log", "show", "status"].includes((args[0] ?? "").toLowerCase())
  }
  if (executable === "certutil") {
    return args.some((arg) => arg.toLowerCase() === "-hashfile")
  }
  return true
}

function managedProjectRoot(path: string): string | undefined {
  if (!existsSync(path)) return
  return findProjectRoot(path) ?? undefined
}

function executableName(value: string): string {
  return value.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? value
}

function isScriptFile(executable: string): boolean {
  return /\.(?:bat|cmd|js|mjs|cjs|ps1|py|sh|ts)$/i.test(executable)
}

function resolveAgainst(cwd: string, path: string): string {
  const value = path.replace(/^["']|["']$/g, "")
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

function finding(
  capability: ProcessCapability,
  executable: string,
  targetDir: string,
  reason: string,
): ProcessCapabilityFinding {
  return { capability, executable, targetDir, reason }
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote = ""
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if ((char === `"` || char === `'`) && command[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char
      current += char
      continue
    }
    if (!quote && (char === ";" || char === "|" || char === "&")) {
      if (current.trim()) segments.push(current.trim())
      current = ""
      while (command[index + 1] === char) index++
      continue
    }
    current += char
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote = ""
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if ((char === `"` || char === `'`) && command[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char
      continue
    }
    if (!quote && /\s/.test(char)) {
      if (current) tokens.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}
