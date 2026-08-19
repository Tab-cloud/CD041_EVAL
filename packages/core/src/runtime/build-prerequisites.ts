import { existsSync, readdirSync, statSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import type { BuildConfig } from "./build-context.ts"

export interface BuildPrerequisites {
  command: string[]
  env: Record<string, string | undefined>
  found: Array<{ name: string; path: string }>
  missing: string[]
  installCommands: string[]
}

/** Resolve build tools without requiring a system-wide PATH modification. */
export function resolveBuildPrerequisites(
  config: BuildConfig,
  command: string[],
  environment: NodeJS.ProcessEnv = process.env,
): BuildPrerequisites {
  const searchDirs: string[] = []
  const found: Array<{ name: string; path: string }> = []
  const missing: string[] = []

  const buildExecutable = findExecutable(
    command[0],
    environment,
    buildToolCandidateRoots(command[0], environment),
    true,
  )
  if (buildExecutable) {
    found.push({ name: command[0], path: buildExecutable })
    searchDirs.push(dirname(buildExecutable))
  } else {
    missing.push(command[0])
  }

  const uniqueDirs = [...new Set(searchDirs)]
  const pathValue = [uniqueDirs.join(delimiter), environment.PATH ?? environment.Path ?? ""]
    .filter(Boolean)
    .join(delimiter)
  const resolvedCommand = [...command]
  if (buildExecutable) resolvedCommand[0] = buildExecutable

  return {
    command: resolvedCommand,
    env: { ...environment, PATH: pathValue },
    found,
    missing: [...new Set(missing)],
    installCommands: missing.length > 0 ? recommendedInstallCommands(config, environment) : [],
  }
}

export function findExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  candidateRoots: string[] = [],
  preferCandidateRoots = false,
): string | undefined {
  const names = process.platform === "win32" && !command.toLowerCase().endsWith(".exe")
    ? [command, `${command}.exe`]
    : [command]

  if (isAbsolute(command) || /[\\/]/.test(command)) {
    for (const name of names) if (existsSync(name)) return name
  }

  const findCandidates = () => {
    for (const root of candidateRoots.filter(Boolean)) {
      const found = findUnderRoot(root, names, 4)
      if (found) return found
    }
    return undefined
  }
  const findPath = () => {
    const pathDirs = (environment.PATH ?? environment.Path ?? "").split(delimiter).filter(Boolean)
    for (const dir of pathDirs) {
      for (const name of names) {
        const candidate = join(dir.replace(/^"|"$/g, ""), name)
        if (existsSync(candidate)) return candidate
      }
    }
    return undefined
  }
  const found = preferCandidateRoots ? findCandidates() ?? findPath() : findPath() ?? findCandidates()
  if (found) return found
  return undefined
}

export function compilerCandidateRoots(environment: NodeJS.ProcessEnv): string[] {
  const roots = [
    environment.ARM_GCC_PATH,
    environment.ARM_TOOLCHAIN_PATH,
    environment.GNU_ARM_EMBEDDED_TOOLCHAIN,
    environment.ProgramFiles ? join(environment.ProgramFiles, "Arm GNU Toolchain arm-none-eabi") : undefined,
    environment["ProgramFiles(x86)"] ? join(environment["ProgramFiles(x86)"]!, "GNU Arm Embedded Toolchain") : undefined,
    environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, "Programs", "Arm GNU Toolchain arm-none-eabi") : undefined,
    // Existing Eval development/tool deployment convention.
    "I:\\I\\MCU\\Tools\\Gcc",
  ]
  return roots.filter((root): root is string => Boolean(root))
}

function buildToolCandidateRoots(command: string, environment: NodeJS.ProcessEnv): string[] {
  const lower = command.toLowerCase()
  const roots = [
    lower === "idf.py" && environment.IDF_PATH ? join(environment.IDF_PATH, "tools") : undefined,
    lower === "idf.py" && environment.USERPROFILE ? join(environment.USERPROFILE, "esp", "esp-idf", "tools") : undefined,
    lower === "idf.py" ? "C:\\Espressif\\frameworks" : undefined,
    lower === "make" || lower === "make.exe"
      ? "C:\\ProgramData\\chocolatey\\lib\\make\\tools\\install\\bin"
      : undefined,
    "C:\\ProgramData\\chocolatey\\bin",
    environment.USERPROFILE ? join(environment.USERPROFILE, "scoop", "shims") : undefined,
    lower.startsWith("cmake") && environment.ProgramFiles ? join(environment.ProgramFiles, "CMake", "bin") : undefined,
    lower.startsWith("cmake") ? "I:\\I\\MCU\\Tools\\CMake\\bin" : undefined,
  ]
  return roots.filter((root): root is string => Boolean(root))
}

function findUnderRoot(root: string, names: string[], depth: number): string | undefined {
  if (!existsSync(root)) return undefined
  try {
    if (statSync(root).isFile()) return names.some((name) => root.toLowerCase().endsWith(name.toLowerCase())) ? root : undefined
    for (const name of names) {
      const direct = join(root, name)
      if (existsSync(direct)) return direct
    }
    if (depth <= 0) return undefined
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const found = findUnderRoot(join(root, entry.name), names, depth - 1)
      if (found) return found
    }
  } catch {
    return undefined
  }
  return undefined
}

function recommendedInstallCommands(config: BuildConfig, environment: NodeJS.ProcessEnv): string[] {
  if (config.buildSystem === "idf") {
    return process.platform === "win32"
      ? ["安装 Espressif 官方 ESP-IDF Tools Installer，并从 ESP-IDF PowerShell 启动 Eval，或设置 IDF_PATH 后重新构建"]
      : ["按照 Espressif 官方文档安装 ESP-IDF，并先执行 export.sh 激活环境"]
  }
  if (process.platform !== "win32") {
    return config.buildSystem === "makefile"
      ? ["sudo apt-get update && sudo apt-get install -y gcc-arm-none-eabi make"]
      : ["sudo apt-get update && sudo apt-get install -y gcc-arm-none-eabi cmake"]
  }
  const commands: string[] = []
  if (findExecutable("winget", environment)) {
    commands.push("winget install --id Arm.GnuArmEmbeddedToolchain --exact --accept-package-agreements --accept-source-agreements")
  }
  if (findExecutable("choco", environment)) {
    commands.push(`choco install -y gcc-arm-embedded${config.buildSystem === "makefile" ? " make" : " cmake"}`)
  }
  if (commands.length === 0) commands.push("安装 GNU Arm Embedded Toolchain，并将其 bin 目录加入 PATH")
  return commands
}
