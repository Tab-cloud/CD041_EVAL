/**
 * Project Config — .eval/project.toml 读写
 *
 * 从工作目录向上查找 .eval/project.toml（优先）或 eval.toml（回退），
 * 提供类型安全的读写接口。
 * TOML 解析使用简单的行解析（零依赖），兼容 Bun。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

export interface ProjectToml {
  project: {
    name: string
    chip: string
    chip_family: string
    /** Target may affect build/programming only after explicit user confirmation. */
    target_confirmed: boolean
    target_evidence?: string
  }
  build: {
    toolchain: string
    /** Explicit backend. "auto" is the only mode allowed to inspect project files. */
    build_system: "auto" | "cmake" | "makefile" | "idf"
    build_dir?: string
    configure_preset?: string
    build_preset?: string
    generator?: string
    toolchain_file?: string
    /** Vendor build target, e.g. esp32s3 for ESP-IDF. */
    platform_target?: string
    timeout_seconds?: number
    c_flags?: string
  }
  debug: { programmer: string; target_cfg: string; serial_port?: string; serial_baud?: number }
  rtos?: { type: string; config?: string }
}

const DEFAULTS: ProjectToml = {
  // An absent project file must never silently select real hardware.  Target
  // identity is safety-critical input for compiler flags and programmers.
  project: { name: "untitled", chip: "", chip_family: "", target_confirmed: false },
  build: { toolchain: "arm-none-eabi-", build_system: "auto" },
  debug: { programmer: "", target_cfg: "" },
}

/** 项目标记文件名：优先查 .eval/project.toml，回退到根目录 eval.toml */
const PROJECT_MARKERS = [".eval/project.toml", "eval.toml"]

export function findProjectRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 20; i++) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function loadProjectConfig(projectRoot: string): ProjectToml {
  const resolvedRoot = findProjectRoot(projectRoot) ?? projectRoot
  // 优先读 .eval/project.toml，回退到 eval.toml
  for (const marker of PROJECT_MARKERS) {
    const path = join(resolvedRoot, marker)
    try {
      const raw = readFileSync(path, "utf-8")
      return parseToml(raw)
    } catch {
      // 文件不存在或不可读，继续尝试下一个
    }
  }
  return { ...DEFAULTS, project: { ...DEFAULTS.project, name: projectRoot.split(/[\\/]/).pop() ?? "untitled" } }
}

/** True only when the project explicitly names a hardware target. */
export function hasConfiguredProjectTarget(config: ProjectToml): boolean {
  return Boolean(config.project.chip.trim() && config.project.target_confirmed)
}

export function saveProjectConfig(projectRoot: string, config: ProjectToml): void {
  // 统一写入 .eval/project.toml
  const evalDir = join(projectRoot, ".eval")
  if (!existsSync(evalDir)) mkdirSync(evalDir, { recursive: true })
  const path = join(evalDir, "project.toml")
  writeFileSync(path, serializeToml(config), "utf-8")
}

// ══════════════════════════════════════════════
// 简易 TOML 解析器（处理我们的固定格式）
// ══════════════════════════════════════════════

function parseToml(raw: string): ProjectToml {
  const config = structuredClone(DEFAULTS) as any
  let currentSection: string | null = null

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    // [section]
    const sectionMatch = trimmed.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      continue
    }

    // key = value
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/)
    if (kvMatch && currentSection) {
      const key = kvMatch[1]
      let value: any = kvMatch[2].trim()

      // 去掉引号
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      } else if (value === "true") value = true
      else if (value === "false") value = false
      else if (/^\d+$/.test(value)) value = parseInt(value)

      const parts = currentSection.split(".")
      let target = config
      for (const p of parts) {
        if (!target[p]) target[p] = {}
        target = target[p]
      }
      target[key] = value
    }
  }

  return config as ProjectToml
}

function serializeToml(config: ProjectToml): string {
  const lines: string[] = [
    "# Eval Project Configuration",
    `# Generated at ${new Date().toISOString()}`,
    "",
  ]

  for (const [section, values] of Object.entries(config)) {
    lines.push(`[${section}]`)
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      const v = typeof value === "string" ? `"${value}"` : String(value)
      lines.push(`${key} = ${v}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
