/**
 * pin_extract 工具
 * 
 * 从原理图分析结果中提取引脚映射表，生成 pinmap.h 和引脚分配文档。
 * 与 schematic_read 工具配合使用。
 */
import { defineTool } from "../../tool/define.ts"
import type { ToolResult } from "../../tool/types.ts"
import { findChip } from "../../knowledge/chips.ts"
import { safePath } from "../helpers"

export const pinExtractTool = defineTool({
  name: "pin_extract",
  description: `从原理图分析结果中提取引脚映射，生成 pinmap.h 头文件和引脚分配文档。

功能：
- 解析 schematic_read 返回的 JSON 数据
- 生成 C 语言的 pinmap.h 头文件（#define 引脚定义）
- 生成 Markdown 格式的引脚分配表
- 验证引脚分配是否与芯片 datasheet 一致
- 检查引脚冲突（同一引脚被多个功能使用）`,

  permission: "write",
  parameters: {
    type: "object",
    properties: {
      schematicJson: {
        type: "object",
        description: "schematic_read 工具返回的 JSON 数据",
      },
      outputDir: {
        type: "string",
        description: "输出目录（pinmap.h 和 pinout.md 的生成路径）",
      },
      chipModel: {
        type: "string",
        description: "MCU 型号，用于验证引脚分配",
      },
    },
    required: ["schematicJson", "outputDir"],
  },

  contract: { effects: ["workspace-write"], idempotency: "idempotent", cancellation: "unsupported", progress: { role: "mutation", targetParameters: ["outputDir"] } },

  async execute(params, ctx): Promise<ToolResult> {
    const schematicJson = params.schematicJson as SchematicOutput
    const chipModel = params.chipModel as string | undefined
    // 收容输出目录到工作目录，防止越权写
    let outputDir: string
    try {
      outputDir = safePath(ctx.workingDir, params.outputDir as string)
    } catch {
      return { success: false, error: `输出目录越权: ${params.outputDir}` }
    }

    // 1. 验证输入
    if (!schematicJson.mcu) {
      return { success: false, error: "原理图 JSON 缺少 mcu 字段" }
    }

    // 2. 芯片验证
    const chipInfo = chipModel ? findChip(chipModel) : findChip(schematicJson.mcu.model)
    let chipWarnings: string[] = []
    if (chipInfo) {
      // 检查 GPIO 数量
      const usedPins = (schematicJson.pins ?? []).length
      if (usedPins > chipInfo.gpio * 0.9) {
        chipWarnings.push(
          `[!] GPIO 利用率较高: ${usedPins}/${chipInfo.gpio} (${((usedPins / chipInfo.gpio) * 100).toFixed(0)}%)`,
        )
      }
      // 检查外设数量
      const peripherals = schematicJson.peripherals ?? []
      const spiDevices = peripherals.filter((p) => p.interface?.toUpperCase().startsWith("SPI"))
      if (spiDevices.length > chipInfo.spi) {
        chipWarnings.push(
          `[!] SPI 外设数量 (${spiDevices.length}) 超过芯片 SPI 接口数 (${chipInfo.spi})`,
        )
      }
      const i2cDevices = peripherals.filter((p) => p.interface?.toUpperCase().startsWith("I2C"))
      if (i2cDevices.length > chipInfo.i2c) {
        chipWarnings.push(
          `[!] I2C 外设数量 (${i2cDevices.length}) 超过芯片 I2C 接口数 (${chipInfo.i2c})`,
        )
      }
    }

    // 3. 引脚冲突检查
    const pinMap = new Map<string, string[]>()
    for (const pin of schematicJson.pins ?? []) {
      const key = pin.pin ?? pin.name ?? "unknown"
      if (!pinMap.has(key)) {
        pinMap.set(key, [])
      }
      pinMap.get(key)!.push(pin.function ?? "unknown")
    }
    const conflicts: string[] = []
    for (const [pin, functions] of pinMap) {
      if (functions.length > 1) {
        conflicts.push(`[!] 引脚冲突: ${pin} → ${functions.join(", ")}`)
      }
    }

    // 4. 生成 pinmap.h
    const pinmapContent = generatePinmapH(schematicJson)
    try {
      await Bun.write(`${outputDir}/pinmap.h`, pinmapContent)
    } catch (err) {
      return { success: false, error: `写入 pinmap.h 失败: ${err}` }
    }

    // 5. 生成引脚分配表 (Markdown)
    const pinoutContent = generatePinoutMd(schematicJson, chipWarnings, conflicts)
    try {
      await Bun.write(`${outputDir}/pinout.md`, pinoutContent)
    } catch (err) {
      return { success: false, error: `写入 pinout.md 失败: ${err}` }
    }

    // 6. 生成引脚分配表 (JSON)
    const pinJson = {
      chip: schematicJson.mcu.model,
      generatedAt: new Date().toISOString(),
      totalPins: schematicJson.pins?.length ?? 0,
      conflicts,
      warnings: chipWarnings,
      pins: schematicJson.pins ?? [],
    }

    return {
      success: true,
      data: {
        pinmapHeader: `${outputDir}/pinmap.h`,
        pinoutDoc: `${outputDir}/pinout.md`,
        pinJson,
        conflicts,
        warnings: chipWarnings,
        summary: `已生成 pinmap.h (${schematicJson.pins?.length ?? 0} 个引脚定义) 和 pinout.md`,
      },
    }
  },
})

// ─── 类型定义 ───
interface SchematicOutput {
  mcu: { model: string; package?: string; core?: string; maxFreq?: string; flash?: string; sram?: string }
  pins?: Array<{ pin?: string; name?: string; function?: string; target?: string; net?: string; type?: string }>
  peripherals?: Array<{ model?: string; function?: string; interface?: string; mcuPins?: string[] }>
  power?: { input?: string; regulators?: Array<{ model?: string; output?: string; maxCurrent?: string }> }
  connectors?: Array<{ type?: string; pins?: string; signals?: Array<{ pin?: string; signal?: string }> }>
  unconnectedPins?: string[]
}

// ─── 生成 pinmap.h ───
function generatePinmapH(data: SchematicOutput): string {
  const lines: string[] = [
    `/**`,
    ` * @file    pinmap.h`,
    ` * @brief   ${data.mcu.model} 引脚映射表`,
    ` * @generated  由 pin_extract 工具自动生成`,
    ` * @date   ${new Date().toISOString().split("T")[0]}`,
    ` */`,
    ``,
    `#ifndef __PINMAP_H__`,
    `#define __PINMAP_H__`,
    ``,
    `#include "main.h"`,
    ``,
    `/* ═══════════════════════════════════════════════════ */`,
    `/* 芯片: ${data.mcu.model} | 封装: ${data.mcu.package ?? "N/A"} | 内核: ${data.mcu.core ?? "N/A"} */`,
    `/* ═══════════════════════════════════════════════════ */`,
    ``,
    `/* ─── GPIO 引脚定义 ─── */`,
  ]

  // 按功能分组
  const groups = groupPins(data.pins ?? [])
  for (const [group, pins] of Object.entries(groups)) {
    lines.push(``)
    lines.push(`/* ─── ${group} ─── */`)
    for (const p of pins) {
      const name = makeDefineName(p)
      const pin = p.pin ?? p.name ?? "UNKNOWN"
      lines.push(`#define ${name}_PIN         ${pin}`)
      const port = extractPort(pin)
      if (port) {
        lines.push(`#define ${name}_PORT        ${port}`)
        lines.push(`#define ${name}_GPIO_CLK    __HAL_RCC_${port}_CLK_ENABLE()`)
      }
    }
  }

  // 外设接口宏
  lines.push(``)
  lines.push(`/* ─── 外设接口定义 ─── */`)
  for (const periph of data.peripherals ?? []) {
    const name = (periph.model ?? "DEVICE").replace(/[^A-Za-z0-9]/g, "_").toUpperCase()
    const iface = periph.interface ?? "UNKNOWN"
    const pins = periph.mcuPins ?? []
    lines.push(``)
    lines.push(`/* ${periph.model ?? "Device"}: ${iface} */`)
    lines.push(`#define ${name}_INTERFACE   ${iface}`)
    pins.forEach((p, i) => {
      lines.push(`#define ${name}_PIN${i}       ${p}`)
    })
  }

  // 未连接引脚
  if (data.unconnectedPins?.length) {
    lines.push(``)
    lines.push(`/* ─── 未使用引脚 (可供扩展) ─── */`)
    lines.push(`#define UNUSED_PINS { ${data.unconnectedPins.join(", ")} }`)
  }

  lines.push(``)
  lines.push(`#endif /* __PINMAP_H__ */`)
  return lines.join("\n")
}

// ─── 生成 pinout.md ───
function generatePinoutMd(
  data: SchematicOutput,
  warnings: string[],
  conflicts: string[],
): string {
  const lines: string[] = [
    `# ${data.mcu.model} 引脚分配表`,
    ``,
    `> 生成时间: ${new Date().toISOString()}`,
    `> 封装: ${data.mcu.package ?? "N/A"} | 内核: ${data.mcu.core ?? "N/A"} | Flash: ${data.mcu.flash ?? "N/A"} | SRAM: ${data.mcu.sram ?? "N/A"}`,
    ``,
  ]

  if (warnings.length > 0) {
    lines.push(`## 警告`)
    for (const w of warnings) {
      lines.push(`- ${w}`)
    }
    lines.push(``)
  }

  if (conflicts.length > 0) {
    lines.push(`## 引脚冲突`)
    for (const c of conflicts) {
      lines.push(`- ${c}`)
    }
    lines.push(``)
  }

  lines.push(`## 引脚分配表`)
  lines.push(``)
  lines.push(`| 引脚号 | 引脚名 | 功能 | 连接目标 | 网络标号 |`)
  lines.push(`|--------|--------|------|----------|----------|`)
  for (const p of data.pins ?? []) {
    lines.push(`| ${p.pin ?? ""} | ${p.name ?? ""} | ${p.function ?? ""} | ${p.target ?? ""} | ${p.net ?? ""} |`)
  }

  if (data.peripherals?.length) {
    lines.push(``)
    lines.push(`## 外设芯片`)
    lines.push(``)
    for (const p of data.peripherals) {
      lines.push(`### ${p.model ?? "Unknown"}`)
      lines.push(`- **功能**: ${p.function ?? "N/A"}`)
      lines.push(`- **接口**: ${p.interface ?? "N/A"}`)
      lines.push(`- **MCU 引脚**: ${(p.mcuPins ?? []).join(", ")}`)
      lines.push(``)
    }
  }

  if (data.power) {
    lines.push(`## 电源设计`)
    lines.push(`- **输入电源**: ${data.power.input ?? "N/A"}`)
    for (const reg of data.power.regulators ?? []) {
      lines.push(`- **${reg.model ?? "Regulator"}**: ${reg.output ?? "N/A"} / ${reg.maxCurrent ?? "N/A"}`)
    }
    lines.push(``)
  }

  if (data.unconnectedPins?.length) {
    lines.push(`## 未使用引脚`)
    lines.push(``)
    lines.push(`以下引脚可供扩展使用：`)
    lines.push(``)
    lines.push(`\`${data.unconnectedPins.join(", ")}\``)
  }

  return lines.join("\n")
}

// ─── 辅助函数 ───
function extractPort(pin: string): string | null {
  const match = pin.match(/^P([A-Z])\d+$/)
  return match ? `GPIO${match[1]}` : null
}

function makeDefineName(pin: { function?: string; net?: string; name?: string }): string {
  const base = (pin.function ?? pin.net ?? pin.name ?? "PIN").toUpperCase()
  return base.replace(/[^A-Za-z0-9]/g, "_").replace(/_{2,}/g, "_")
}

function groupPins(pins: Array<{ function?: string; name?: string; pin?: string }>): Record<string, typeof pins> {
  const groups: Record<string, typeof pins> = {}
  for (const p of pins) {
    const group = p.function ?? "OTHER"
    if (!groups[group]) groups[group] = []
    groups[group].push(p)
  }
  return groups
}
