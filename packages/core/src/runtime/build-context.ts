/**
 * Build Context
 *
 * Resolves project configuration into one immutable build request. The request
 * is the authority shared by execution, artifact verification and download.
 */

import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, extname, join, relative, resolve } from "node:path"
import {
  findProjectRoot,
  hasConfiguredProjectTarget,
  loadProjectConfig,
} from "../store/project-config.ts"
import { assertEspBuildContract } from "./esp-build-scope.ts"
import type {
  BuildMode,
  BuildRequest,
  BuildSystem,
  BuildTargetSnapshot,
} from "../tool/hardware/build-types.ts"

export type { BuildSystem } from "../tool/hardware/build-types.ts"

export interface BuildConfig {
  projectDir: string
  projectRoot: string
  projectName: string
  buildDir: string
  buildSystem: BuildSystem
  buildSystemSource: "project-config" | "auto-detection"
  toolchain: string
  chipModel?: string
  chipFamily?: string
  chipEvidence?: string
  chipSource: "project-config" | "unconfigured" | "unconfirmed"
  target: string
  jobs: number
  timeoutMs: number
  mode: BuildMode
  configurePreset?: string
  buildPreset?: string
  generator?: string
  toolchainFile?: string
  platformTarget?: string
}

const BUILD_SYSTEMS = new Set<BuildSystem>(["cmake", "makefile", "idf"])
const BUILD_MODES = new Set<BuildMode>(["incremental", "rebuild", "clean"])
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.+/-]{0,127}$/
const INPUT_NAMES = new Set([
  "makefile", "gnumakefile", "cmakelists.txt", "cmakepresets.json",
  "cmakeuserpresets.json", "sdkconfig", "sdkconfig.defaults",
])
const INPUT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".s", ".asm",
  ".ld", ".lds", ".cmake", ".mk", ".mak", ".json", ".toml", ".yaml", ".yml",
])
const EXCLUDED_DIRECTORIES = new Set([
  ".git", "node_modules", "release", "target-package", "target-package-20260724",
])

/** Detect only when project configuration explicitly requests auto mode. */
export function detectBuildSystem(projectDir: string): BuildSystem {
  if (existsSync(join(projectDir, "CMakeLists.txt"))) {
    if (isEspIdfProject(projectDir)) return "idf"
    return "cmake"
  }
  if (existsSync(join(projectDir, "Makefile")) || existsSync(join(projectDir, "GNUmakefile"))) {
    return "makefile"
  }
  throw new Error("未配置可执行的构建后端；请在 .eval/project.toml 设置 build_system，禁止从源码猜测 GCC 链接流程")
}

export function buildConfigFromContext(
  projectDirValue: string,
  opts?: {
    target?: string
    jobs?: number
    toolchain?: string
    mode?: BuildMode
  },
): BuildConfig {
  const projectDir = resolve(projectDirValue)
  const projectRoot = findProjectRoot(projectDir) ?? projectDir
  const config = loadProjectConfig(projectRoot)
  const configuredSystem = config.build.build_system
  const buildSystem = BUILD_SYSTEMS.has(configuredSystem as BuildSystem)
    ? configuredSystem as BuildSystem
    : detectBuildSystem(projectDir)
  const buildSystemSource = BUILD_SYSTEMS.has(configuredSystem as BuildSystem)
    ? "project-config" as const
    : "auto-detection" as const
  assertBackendDefinition(projectDir, buildSystem)

  const target = opts?.target?.trim() || "all"
  if (!TARGET_PATTERN.test(target)) throw new Error(`构建目标格式无效: ${target}`)
  const jobs = opts?.jobs ?? 4
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 32) throw new Error("并行编译数必须在 1 到 32 之间")
  const timeoutSeconds = config.build.timeout_seconds ?? 900
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3_600) {
    throw new Error("构建超时必须在 30 到 3600 秒之间")
  }
  const mode = opts?.mode ?? "incremental"
  if (!BUILD_MODES.has(mode)) throw new Error(`构建模式无效: ${mode}`)

  const buildDir = resolveInside(projectDir, config.build.build_dir ?? "build", "构建目录")
  const toolchainFile = config.build.toolchain_file
    ? resolveInside(projectRoot, config.build.toolchain_file, "CMake toolchain_file")
    : undefined
  const targetConfigured = hasConfiguredProjectTarget(config)
  const declaredChip = config.project.chip.trim()
  const chipModel = targetConfigured ? declaredChip : undefined
  const platformTarget = nonEmpty(config.build.platform_target)

  return {
    projectDir,
    projectRoot,
    projectName: config.project.name.trim() || basename(projectDir),
    buildDir,
    buildSystem,
    buildSystemSource,
    toolchain: normalizeToolchainPrefix(opts?.toolchain ?? config.build.toolchain ?? ""),
    chipModel,
    chipFamily: targetConfigured ? config.project.chip_family.trim() : undefined,
    chipEvidence: targetConfigured ? config.project.target_evidence?.trim() : undefined,
    chipSource: targetConfigured ? "project-config" : declaredChip ? "unconfirmed" : "unconfigured",
    target,
    jobs,
    timeoutMs: timeoutSeconds * 1_000,
    mode,
    configurePreset: nonEmpty(config.build.configure_preset),
    buildPreset: nonEmpty(config.build.build_preset),
    generator: nonEmpty(config.build.generator),
    toolchainFile,
    platformTarget,
  }
}

export function createBuildRequest(config: BuildConfig): BuildRequest {
  if (!config.chipModel) throw new Error("目标芯片尚未确认，不能创建构建请求")
  assertEspBuildContract({
    projectRoot: config.projectRoot,
    chipModel: config.chipModel,
    buildSystem: config.buildSystem,
    platformTarget: config.platformTarget,
  })
  const targetSnapshot: BuildTargetSnapshot = {
    model: config.chipModel,
    family: config.chipFamily ?? "",
    evidence: config.chipEvidence ?? "用户确认",
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    requestId: randomUUID(),
    createdAt: new Date().toISOString(),
    projectDir: config.projectDir,
    projectRoot: config.projectRoot,
    projectName: config.projectName,
    buildDir: config.buildDir,
    buildSystem: config.buildSystem,
    buildSystemSource: config.buildSystemSource,
    mode: config.mode,
    target: config.target,
    jobs: config.jobs,
    timeoutMs: config.timeoutMs,
    toolchain: config.toolchain,
    configurePreset: config.configurePreset,
    buildPreset: config.buildPreset,
    generator: config.generator,
    toolchainFile: config.toolchainFile,
    platformTarget: config.platformTarget,
    targetSnapshot: Object.freeze(targetSnapshot),
    inputFingerprint: fingerprintBuildInputs(config, targetSnapshot),
  })
}

export function formatBuildTargetLabel(config: Pick<BuildConfig, "chipModel" | "chipFamily">): string {
  if (!config.chipModel) return "未确认"
  return config.chipFamily ? `${config.chipModel} (${config.chipFamily})` : config.chipModel
}

export function normalizeToolchainPrefix(value: string): string {
  return value.trim().replace(/(?:gcc|cc)(?:\.exe)?$/i, "")
}

function assertBackendDefinition(projectDir: string, system: BuildSystem): void {
  const valid = system === "cmake"
    ? existsSync(join(projectDir, "CMakeLists.txt")) || existsSync(join(projectDir, "CMakePresets.json"))
    : system === "makefile"
      ? existsSync(join(projectDir, "Makefile")) || existsSync(join(projectDir, "GNUmakefile"))
      : isEspIdfProject(projectDir)
  if (!valid) throw new Error(`配置声明 build_system="${system}"，但项目中缺少对应构建定义`)
}

function fingerprintBuildInputs(config: BuildConfig, targetSnapshot: BuildTargetSnapshot): string {
  const hash = createHash("sha256")
  hash.update(JSON.stringify({
    buildSystem: config.buildSystem,
    target: config.target,
    toolchain: config.toolchain,
    chipModel: config.chipModel,
    chipFamily: config.chipFamily,
    configurePreset: config.configurePreset,
    buildPreset: config.buildPreset,
    generator: config.generator,
    toolchainFile: config.toolchainFile,
    platformTarget: config.platformTarget,
    targetSnapshot,
  }))
  const files: string[] = []
  collectInputs(config.projectDir, config.buildDir, files)
  const projectConfig = join(config.projectRoot, ".eval", "project.toml")
  if (existsSync(projectConfig) && !files.includes(projectConfig)) files.push(projectConfig)
  const targetSelection = join(config.projectRoot, ".eval", "target.json")
  if (existsSync(targetSelection) && !files.includes(targetSelection)) files.push(targetSelection)
  const packs = join(config.projectRoot, ".eval", "device-packs")
  if (existsSync(packs)) collectInputs(packs, config.buildDir, files)
  for (const path of files.sort((a, b) => a.localeCompare(b))) {
    const rel = relative(config.projectRoot, path).replace(/\\/g, "/")
    hash.update(rel)
    hash.update("\0")
    hash.update(readFileSync(path))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function isEspIdfProject(projectDir: string): boolean {
  const cmakePath = join(projectDir, "CMakeLists.txt")
  if (!existsSync(cmakePath)) return false
  if (existsSync(join(projectDir, "sdkconfig"))) return true
  try {
    return /IDF_PATH|project\.cmake|idf_component_register/i.test(readFileSync(cmakePath, "utf8"))
  } catch {
    return false
  }
}

function collectInputs(directory: string, buildDir: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (resolve(path) === resolve(buildDir) || EXCLUDED_DIRECTORIES.has(entry.name)) continue
      collectInputs(path, buildDir, files)
      continue
    }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (INPUT_NAMES.has(lower) || INPUT_EXTENSIONS.has(extname(lower))) files.push(path)
  }
}

function resolveInside(root: string, value: string, label: string): string {
  const path = resolve(root, value)
  const rel = relative(root, path)
  if (rel.startsWith("..") || resolve(root, rel) !== path) throw new Error(`${label}必须位于项目目录内`)
  return path
}

function nonEmpty(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result || undefined
}
