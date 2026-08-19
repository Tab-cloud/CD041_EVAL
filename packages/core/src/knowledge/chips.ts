/**
 * 嵌入式芯片知识库
 * 
 * 芯片型号 → 详细规格的映射，供 Agent 查询使用。
 * 格式参考 OpenCode Config Schema。
 */

export interface ChipInfo {
  model: string
  family: string
  manufacturer: string
  core: string
  maxFreq: string
  flash: string
  sram: string
  package: string[]
  gpio: number
  uart: number
  spi: number
  i2c: number
  adc: { channels: number; bits: number }
  timers: number
  usb: boolean
  can: boolean
  dma: boolean
  debug: string
  datasheet: string
  platform?: {
    buildSystem: "idf"
    buildTarget: string
    programmer: "esptool"
  }
}

export interface ChipCompilerFlags {
  cpuFlags: string          // -mcpu=xxx -mthumb
  fpuFlags?: string         // -mfpu=fpv4-sp-d16 (仅 M4F)
  floatAbi?: string         // -mfloat-abi=hard (仅 M4F)
  toolchain?: string        // 工具链前缀（ARM 由 project.toml 提供；ESP 等非 ARM 由芯片定义）
  /** 完整的 CPU 编译标志组合 */
  full: string              // 所有标志用空格连接
}

/** STM32 常用芯片数据库 */
export const CHIP_DATABASE: Record<string, ChipInfo> = {
  // ─── STM32F1 系列 ───
  "STM32F103C8T6": {
    model: "STM32F103C8T6", family: "STM32F1", manufacturer: "STMicroelectronics",
    core: "Cortex-M3", maxFreq: "72MHz", flash: "64KB", sram: "20KB",
    package: ["LQFP48"], gpio: 37, uart: 3, spi: 2, i2c: 2,
    adc: { channels: 10, bits: 12 }, timers: 4, usb: true, can: true, dma: true,
    debug: "SWD", datasheet: "https://www.st.com/resource/en/datasheet/stm32f103c8.pdf",
  },
  "STM32F103CBT6": {
    model: "STM32F103CBT6", family: "STM32F1", manufacturer: "STMicroelectronics",
    core: "Cortex-M3", maxFreq: "72MHz", flash: "128KB", sram: "20KB",
    package: ["LQFP48"], gpio: 37, uart: 3, spi: 2, i2c: 2,
    adc: { channels: 10, bits: 12 }, timers: 4, usb: true, can: true, dma: true,
    debug: "SWD", datasheet: "https://www.st.com/resource/en/datasheet/stm32f103cb.pdf",
  },
  "STM32F103VET6": {
    model: "STM32F103VET6", family: "STM32F1", manufacturer: "STMicroelectronics",
    core: "Cortex-M3", maxFreq: "72MHz", flash: "512KB", sram: "64KB",
    package: ["LQFP100"], gpio: 80, uart: 5, spi: 3, i2c: 2,
    adc: { channels: 16, bits: 12 }, timers: 8, usb: true, can: true, dma: true,
    debug: "SWD + JTAG", datasheet: "https://www.st.com/resource/en/datasheet/stm32f103ve.pdf",
  },

  // ─── STM32F4 系列 ───
  "STM32F407VET6": {
    model: "STM32F407VET6", family: "STM32F4", manufacturer: "STMicroelectronics",
    core: "Cortex-M4F", maxFreq: "168MHz", flash: "512KB", sram: "192KB",
    package: ["LQFP100"], gpio: 82, uart: 6, spi: 3, i2c: 3,
    adc: { channels: 16, bits: 12 }, timers: 14, usb: true, can: true, dma: true,
    debug: "SWD + JTAG", datasheet: "https://www.st.com/resource/en/datasheet/stm32f407ve.pdf",
  },
  "STM32F407ZGT6": {
    model: "STM32F407ZGT6", family: "STM32F4", manufacturer: "STMicroelectronics",
    core: "Cortex-M4F", maxFreq: "168MHz", flash: "1MB", sram: "192KB",
    package: ["LQFP144"], gpio: 114, uart: 6, spi: 3, i2c: 3,
    adc: { channels: 24, bits: 12 }, timers: 14, usb: true, can: true, dma: true,
    debug: "SWD + JTAG", datasheet: "https://www.st.com/resource/en/datasheet/stm32f407zg.pdf",
  },

  // ─── STM32G0 系列 (低成本) ───
  "STM32G030F6P6": {
    model: "STM32G030F6P6", family: "STM32G0", manufacturer: "STMicroelectronics",
    core: "Cortex-M0+", maxFreq: "64MHz", flash: "32KB", sram: "8KB",
    package: ["TSSOP20"], gpio: 17, uart: 2, spi: 1, i2c: 1,
    adc: { channels: 8, bits: 12 }, timers: 5, usb: false, can: false, dma: true,
    debug: "SWD", datasheet: "https://www.st.com/resource/en/datasheet/stm32g030f6.pdf",
  },
  "STM32G070RBT6": {
    model: "STM32G070RBT6", family: "STM32G0", manufacturer: "STMicroelectronics",
    core: "Cortex-M0+", maxFreq: "64MHz", flash: "128KB", sram: "36KB",
    package: ["LQFP64"], gpio: 59, uart: 4, spi: 2, i2c: 2,
    adc: { channels: 16, bits: 12 }, timers: 11, usb: false, can: false, dma: true,
    debug: "SWD", datasheet: "https://www.st.com/resource/en/datasheet/stm32g070rb.pdf",
  },

  // ─── GD32F3 系列 ───
  "GD32F303CCT6": {
    model: "GD32F303CCT6", family: "GD32F3", manufacturer: "GigaDevice",
    core: "Cortex-M4F", maxFreq: "120MHz", flash: "256KB", sram: "48KB",
    package: ["LQFP48"], gpio: 37, uart: 3, spi: 3, i2c: 2,
    adc: { channels: 10, bits: 12 }, timers: 6, usb: true, can: true, dma: true,
    debug: "SWD", datasheet: "https://www.gigadevice.com.cn/product/mcu/gd32f303",
  },
  "GD32F303VET6": {
    model: "GD32F303VET6", family: "GD32F3", manufacturer: "GigaDevice",
    core: "Cortex-M4F", maxFreq: "120MHz", flash: "512KB", sram: "64KB",
    package: ["LQFP100"], gpio: 80, uart: 5, spi: 3, i2c: 3,
    adc: { channels: 16, bits: 12 }, timers: 10, usb: true, can: true, dma: true,
    debug: "SWD + JTAG", datasheet: "https://www.gigadevice.com.cn/product/mcu/gd32f303",
  },

  // ─── ESP32 系列 ───
  "ESP32": {
    model: "ESP32", family: "ESP32", manufacturer: "Espressif",
    core: "Xtensa LX6", maxFreq: "240MHz", flash: "4MB", sram: "520KB",
    package: ["QFN48"], gpio: 34, uart: 3, spi: 4, i2c: 2,
    adc: { channels: 18, bits: 12 }, timers: 4, usb: false, can: false, dma: true,
    debug: "JTAG", datasheet: "https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf",
    platform: { buildSystem: "idf", buildTarget: "esp32", programmer: "esptool" },
  },
  "ESP32-S3": {
    model: "ESP32-S3", family: "ESP32-S3", manufacturer: "Espressif",
    core: "Xtensa LX7", maxFreq: "240MHz", flash: "16MB", sram: "512KB",
    package: ["QFN56"], gpio: 45, uart: 3, spi: 4, i2c: 2,
    adc: { channels: 20, bits: 12 }, timers: 4, usb: true, can: false, dma: true,
    debug: "JTAG + USB", datasheet: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf",
    platform: { buildSystem: "idf", buildTarget: "esp32s3", programmer: "esptool" },
  },
  "ESP32-C3": {
    model: "ESP32-C3", family: "ESP32-C3", manufacturer: "Espressif",
    core: "RISC-V 32", maxFreq: "160MHz", flash: "4MB", sram: "400KB",
    package: ["QFN32"], gpio: 22, uart: 2, spi: 3, i2c: 1,
    adc: { channels: 6, bits: 12 }, timers: 2, usb: true, can: false, dma: true,
    debug: "JTAG + USB", datasheet: "https://www.espressif.com/sites/default/files/documentation/esp32-c3_datasheet_en.pdf",
    platform: { buildSystem: "idf", buildTarget: "esp32c3", programmer: "esptool" },
  },
  "ESP32-C6": {
    model: "ESP32-C6", family: "ESP32-C6", manufacturer: "Espressif",
    core: "RISC-V 32", maxFreq: "160MHz", flash: "8MB", sram: "512KB",
    package: ["QFN40"], gpio: 30, uart: 3, spi: 2, i2c: 2,
    adc: { channels: 7, bits: 12 }, timers: 3, usb: true, can: false, dma: true,
    debug: "JTAG + USB", datasheet: "https://www.espressif.com/sites/default/files/documentation/esp32-c6_datasheet_en.pdf",
    platform: { buildSystem: "idf", buildTarget: "esp32c6", programmer: "esptool" },
  },
}

// ══════════════════════════════════════════════
// 芯片加载（内置 + 全局 + 项目）
// ══════════════════════════════════════════════

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/** 从 JSON 文件加载芯片定义（静默失败，返回 []） */
function loadChipsJson(filePath: string): ChipInfo[] {
  try {
    if (!existsSync(filePath)) return []
    const raw = readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    // 简单校验：每个条目必须有 model 字段
    return data.filter((c: any) => typeof c.model === "string" && c.model.trim())
  } catch {
    return []
  }
}

/**
 * 获取合并后的芯片数据库。
 *
 * 优先级（从高到低，按 model 名去重）：
 *   1. 项目级: <projectDir>/.eval/chips.json
 *   2. 全局级: ~/.eval/chips.json
 *   3. 内置级: chips.ts CHIP_DATABASE
 */
function getMergedChips(projectDir?: string): Record<string, ChipInfo> {
  const merged: Record<string, ChipInfo> = {}

  // 内置库（最低优先级）
  for (const [key, chip] of Object.entries(CHIP_DATABASE)) {
    merged[key.toUpperCase()] = chip
  }

  // 全局芯片库
  const globalPath = join(homedir(), ".eval", "chips.json")
  for (const chip of loadChipsJson(globalPath)) {
    const key = chip.model.toUpperCase()
    if (!merged[key]) merged[key] = chip
  }

  // 项目级芯片库（最高优先级，覆盖全局）
  if (projectDir) {
    const projectPath = join(projectDir, ".eval", "chips.json")
    for (const chip of loadChipsJson(projectPath)) {
      const key = chip.model.toUpperCase()
      merged[key] = chip  // 覆盖同名芯片
    }
  }

  return merged
}

interface VersionedChipRegistry {
  revision: string
  chips: Record<string, ChipInfo>
}

/**
 * Chip registries are writable project evidence, not immutable process
 * configuration. Cache entries therefore carry a content revision and are
 * reloaded whenever either the project or global registry changes.
 */
const _chipsCache = new Map<string, VersionedChipRegistry>()
let _globalCache: VersionedChipRegistry | null = null

/** 清空缓存（chip_add 工具写入 chips.json 后调用，使新芯片立即可用） */
export function clearChipsCache() {
  _chipsCache.clear()
  _globalCache = null
}

/** 查找芯片信息（搜索内置 + 全局 + 项目芯片库） */
export function findChip(model: string, projectDir?: string): ChipInfo | undefined {
  const key = model.toUpperCase()
  // 先查项目级（如果有 projectDir）
  if (projectDir) {
    const revision = chipRegistryRevision(projectDir)
    const cached = _chipsCache.get(projectDir)
    if (!cached || cached.revision !== revision) {
      _chipsCache.set(projectDir, { revision, chips: getMergedChips(projectDir) })
    }
    const projChip = _chipsCache.get(projectDir)!.chips[key]
    if (projChip) return projChip
  }
  // 回退到全局 + 内置
  const revision = chipRegistryRevision()
  if (!_globalCache || _globalCache.revision !== revision) {
    _globalCache = { revision, chips: getMergedChips() }
  }
  return _globalCache.chips[key]
}

/** 按系列列出芯片（搜索内置 + 全局 + 项目芯片库） */
export function listChipsByFamily(family: string, projectDir?: string): ChipInfo[] {
  const revision = chipRegistryRevision(projectDir)
  let db: Record<string, ChipInfo>
  if (projectDir) {
    const cached = _chipsCache.get(projectDir)
    if (!cached || cached.revision !== revision) {
      _chipsCache.set(projectDir, { revision, chips: getMergedChips(projectDir) })
    }
    db = _chipsCache.get(projectDir)!.chips
  } else {
    if (!_globalCache || _globalCache.revision !== revision) {
      _globalCache = { revision, chips: getMergedChips() }
    }
    db = _globalCache.chips
  }
  return Object.values(db).filter(
    (c) => c.family.toUpperCase() === family.toUpperCase(),
  )
}

function chipRegistryRevision(projectDir?: string): string {
  const paths = [
    join(homedir(), ".eval", "chips.json"),
    ...(projectDir ? [join(projectDir, ".eval", "chips.json")] : []),
  ]
  const hash = createHash("sha256")
  for (const path of paths) {
    hash.update(path)
    hash.update("\0")
    try {
      hash.update(readFileSync(path))
    } catch {
      hash.update("<missing>")
    }
    hash.update("\0")
  }
  return hash.digest("hex")
}

// ══════════════════════════════════════════════
// 内核 → 编译标志映射表
// ══════════════════════════════════════════════

/**
 * 内核编译标志查表。按 key 匹配芯片的 core 字段（大小写不敏感）。
 * 匹配规则：core.includes(key)，优先精确匹配（长 key 优先）。
 *
 * ARM 芯片 toolchain 由 project.toml 提供（默认 arm-none-eabi-）；
 * 非 ARM 芯片（ESP Xtensa/RISC-V）由表中定义。
 */
const CORE_FLAGS: Array<{ key: string; flags: Partial<ChipCompilerFlags> }> = [
  { key: "cortex-m4f",   flags: { cpuFlags: "-mcpu=cortex-m4 -mthumb", fpuFlags: "-mfpu=fpv4-sp-d16", floatAbi: "-mfloat-abi=hard", full: "-mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16" } },
  { key: "cortex-m4",    flags: { cpuFlags: "-mcpu=cortex-m4 -mthumb", full: "-mcpu=cortex-m4 -mthumb" } },
  { key: "cortex-m3",    flags: { cpuFlags: "-mcpu=cortex-m3 -mthumb", full: "-mcpu=cortex-m3 -mthumb" } },
  { key: "cortex-m7",    flags: { cpuFlags: "-mcpu=cortex-m7 -mthumb", fpuFlags: "-mfpu=fpv5-d16", floatAbi: "-mfloat-abi=hard", full: "-mcpu=cortex-m7 -mthumb -mfloat-abi=hard -mfpu=fpv5-d16" } },
  { key: "cortex-m33",   flags: { cpuFlags: "-mcpu=cortex-m33 -mthumb", full: "-mcpu=cortex-m33 -mthumb" } },
  { key: "cortex-m0+",   flags: { cpuFlags: "-mcpu=cortex-m0plus -mthumb", full: "-mcpu=cortex-m0plus -mthumb" } },
  { key: "cortex-m0",    flags: { cpuFlags: "-mcpu=cortex-m0 -mthumb", full: "-mcpu=cortex-m0 -mthumb" } },
  // ESP/通用 RISC-V 系列（非 ARM，工具链由芯片定义）
  { key: "xtensa lx7",   flags: { full: "", toolchain: "xtensa-esp32-elf-" } },
  { key: "xtensa lx",    flags: { full: "", toolchain: "xtensa-esp32-elf-" } },
  { key: "risc-v 32",    flags: { full: "", toolchain: "riscv32-esp-elf-" } },
  { key: "risc-v",       flags: { full: "", toolchain: "riscv-none-embed-" } },
]

/** 从芯片信息推导 GCC 编译标志（查表 + 最佳匹配） */
export function getChipCompilerFlags(chip: ChipInfo): ChipCompilerFlags {
  const core = chip.core.toLowerCase()
  for (const entry of CORE_FLAGS) {
    if (core.includes(entry.key)) {
      return {
        cpuFlags: entry.flags.cpuFlags ?? "",
        fpuFlags: entry.flags.fpuFlags,
        floatAbi: entry.flags.floatAbi,
        toolchain: entry.flags.toolchain,
        full: entry.flags.full ?? "",
      }
    }
  }
  // 未知内核 → M0+ 默认（最保守）
  return {
    cpuFlags: "-mcpu=cortex-m0plus -mthumb",
    full: "-mcpu=cortex-m0plus -mthumb",
  }
}

/** 便捷函数：按型号名查找芯片并返回编译标志 */
export function getChipByName(model: string): { chip?: ChipInfo; flags?: ChipCompilerFlags } {
  const chip = findChip(model)
  if (!chip) return {}
  return { chip, flags: getChipCompilerFlags(chip) }
}
