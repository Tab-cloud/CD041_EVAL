/**
 * chip_add 工具 — 通过对话添加芯片型号到芯片库
 *
 * 用户说出芯片型号，LLM 查手册获取参数后调用此工具，
 * 自动写入 ~/.eval/chips.json（全局）或 <项目>/.eval/chips.json（项目级）。
 */
import { defineTool } from "../define"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { clearChipsCache } from "../../knowledge/chips.ts"
import { safePath } from "../helpers"

export const chipAddTool = defineTool({
  name: "chip_add",
  description: `添加或更新芯片型号到芯片库。

LLM 工作流程：先用 websearch/webfetch 查数据手册获取准确参数，然后调用此工具写入芯片库。
芯片库用于型号识别、源码设计和项目初始化；Eval 内置 compile 仅执行带有受支持 ESP-IDF
平台元数据的 Espressif 芯片，其他芯片由用户在厂商环境中手动编译。

参数：
- model: 芯片型号（必填），如 "STM32H743VIT6"
- core: 内核类型，如 "Cortex-M7"（决定编译标志）
- family: 芯片系列，如 "STM32H7"
- manufacturer: 制造商
- maxFreq: 主频
- flash: Flash 大小
- sram: SRAM 大小
- gpio, uart, spi, i2c, timers: 外设数量
- adcChannels, adcBits: ADC 参数
- usb, can, dma: 布尔值
- debug: 调试接口
- datasheet: 数据手册 URL
- platformTarget: Espressif 芯片的 ESP-IDF target（如 esp32h2）；提供后该芯片可进入内置编译
- catalogPath: 项目芯片库路径，项目级固定使用 ".eval/chips.json"
- scope: "project"（项目级，默认）或 "global"（全局）`,

  permission: "write",
  parameters: {
    type: "object",
    properties: {
      model:        { type: "string", description: "芯片型号（必填），如 STM32H743VIT6" },
      family:       { type: "string", description: "芯片系列" },
      manufacturer: { type: "string", description: "制造商" },
      core:         { type: "string", description: "内核类型，如 Cortex-M7" },
      maxFreq:      { type: "string", description: "主频" },
      flash:        { type: "string", description: "Flash 大小" },
      sram:         { type: "string", description: "SRAM 大小" },
      gpio:         { type: "number", description: "GPIO 数量" },
      uart:         { type: "number", description: "UART 数量" },
      spi:          { type: "number", description: "SPI 数量" },
      i2c:          { type: "number", description: "I2C 数量" },
      adcChannels:  { type: "number", description: "ADC 通道数" },
      adcBits:      { type: "number", description: "ADC 分辨率" },
      timers:       { type: "number", description: "定时器数量" },
      usb:          { type: "boolean", description: "是否支持 USB" },
      can:          { type: "boolean", description: "是否支持 CAN" },
      dma:          { type: "boolean", description: "是否支持 DMA" },
      debug:        { type: "string", description: "调试接口" },
      datasheet:    { type: "string", description: "数据手册 URL" },
      platformTarget: { type: "string", description: "Espressif 芯片的 ESP-IDF target，如 esp32h2" },
      catalogPath: { type: "string", description: `项目芯片库目标；项目级使用 ".eval/chips.json"` },
      scope:        { type: "string", enum: ["project", "global"], description: `保存位置：“project”（项目级，默认）或 "global"（全局）` },
    },
    required: ["model", "catalogPath"],
  },

  contract: {
    effects: ["workspace-read", "workspace-write"],
    idempotency: "idempotent",
    cancellation: "unsupported",
    progress: { role: "mutation", targetParameters: ["catalogPath"] },
  },

  async execute(params, ctx) {
    const model = ((params.model as string) ?? "").trim()
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(model)) return { success: false, error: "芯片型号只能包含字母、数字、点、下划线和连字符" }

    const scope = ((params.scope as string) ?? "project").toLowerCase()
    if (scope === "global" && ctx.scope !== "full-access") {
      return { success: false, error: "写入全局芯片库需要完整访问模式" }
    }
    const catalogPath = typeof params.catalogPath === "string"
      ? params.catalogPath.trim().replace(/\\/g, "/")
      : ".eval/chips.json"
    if (scope === "project" && catalogPath !== ".eval/chips.json") {
      return { success: false, error: `项目芯片库路径必须是 .eval/chips.json，收到: ${catalogPath}` }
    }
    const targetPath = scope === "global"
      ? join(homedir(), ".eval", "chips.json")
      : safePath(ctx.workingDir, catalogPath)

    // 确保目录存在
    const targetDir = dirname(targetPath)
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })

    // 读取现有芯片列表
    let chips: any[] = []
    try {
      if (existsSync(targetPath)) {
        const raw = readFileSync(targetPath, "utf-8")
        chips = JSON.parse(raw)
        if (!Array.isArray(chips)) chips = []
      }
    } catch {
      chips = []
    }

    // 构造新芯片条目（只存有值的字段）
    const entry: Record<string, unknown> = { model }
    const strFields = ["family", "manufacturer", "core", "maxFreq", "flash", "sram", "debug", "datasheet"]
    for (const f of strFields) {
      const v = (params as any)[f]
      if (typeof v === "string" && v.trim()) entry[f] = v.trim()
    }
    const numFields = ["gpio", "uart", "spi", "i2c", "timers"]
    for (const f of numFields) {
      const v = (params as any)[f]
      if (typeof v === "number") entry[f] = v
    }
    const boolFields = ["usb", "can", "dma"]
    for (const f of boolFields) {
      const v = (params as any)[f]
      if (typeof v === "boolean") entry[f] = v
    }
    // ADC 子对象
    const adcChannels = (params as any).adcChannels
    const adcBits = (params as any).adcBits
    if (typeof adcChannels === "number" || typeof adcBits === "number") {
      entry.adc = {
        channels: typeof adcChannels === "number" ? adcChannels : 10,
        bits: typeof adcBits === "number" ? adcBits : 12,
      }
    }
    const platformTarget = typeof params.platformTarget === "string"
      ? params.platformTarget.trim().toLowerCase()
      : ""
    if (platformTarget) {
      if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(platformTarget)) {
        return { success: false, error: "ESP-IDF platformTarget 格式无效" }
      }
      if (String(entry.manufacturer ?? "").toLowerCase() !== "espressif") {
        return { success: false, error: "只有 manufacturer=Espressif 的芯片可以声明 ESP-IDF platformTarget" }
      }
      entry.platform = {
        buildSystem: "idf",
        buildTarget: platformTarget,
        programmer: "esptool",
      }
    }

    // 查找同名芯片：存在则更新，不存在则追加
    const key = model.toUpperCase()
    const idx = chips.findIndex((c: any) => (c.model || "").toUpperCase() === key)
    if (idx >= 0) {
      chips[idx] = { ...chips[idx], ...entry }
    } else {
      chips.push(entry)
    }

    // 原子写入：先写 .tmp 再 rename
    const tmpPath = targetPath + ".tmp"
    try {
      writeFileSync(tmpPath, JSON.stringify(chips, null, 2), "utf-8")
      renameSync(tmpPath, targetPath)
    } catch {
      // Windows 下 rename 可能失败（跨设备），回退直接写
      try { unlinkSync(tmpPath) } catch {}
      writeFileSync(targetPath, JSON.stringify(chips, null, 2), "utf-8")
    }

    // 清除 findChip 内存缓存，使新芯片立即可用
    clearChipsCache()

    return {
      success: true,
      data: {
        model,
        core: entry.core ?? "未知",
        scope,
        path: targetPath,
        action: idx >= 0 ? "updated" : "added",
      },
    }
  },
})
