/**
 * usb 工具 — USB 设备只读枚举
 *
 * 在 Tauri 环境中委托 Rust 后端（rusb/nusb crate），
 * 在 CLI 环境使用系统枚举命令。固件下载统一由 ESP programmer
 * 服务负责，避免检测工具旁路目标校验和产物认证。
 */
import { defineTool } from "../define.ts"
import type { ToolResult } from "../types.ts"
import { runProcess } from "../process"

export const usbTool = defineTool({
  name: "usb_detect",
  description: `只读检测 USB 设备连接。

功能：
- 枚举所有 USB 设备（VID/PID/序列号/制造商）
- 检测 USB HID 设备
- 检测 USB CDC/ACM 虚拟串口

参数：
- action: 操作类型 (list / hid-list)
- vid: USB Vendor ID (过滤用，如 303a)
- pid: USB Product ID (过滤用)

本工具不烧录、不复位、不切换设备模式。ESP 固件下载必须使用 flash 工具。`,

  permission: "usb",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "hid-list"], description: "只读枚举操作" },
      vid: { type: "string", description: "Vendor ID (hex)" },
      pid: { type: "string", description: "Product ID (hex)" },
    },
    required: ["action"],
    additionalProperties: false,
  },

  contract: {
    effects: ["process", "hardware"],
    idempotency: "read-only",
    cancellation: "cooperative",
    progress: { role: "inspection", targetParameters: ["vid", "pid"] },
  },

  async execute(params, ctx): Promise<ToolResult> {
    const action = params.action as string

    switch (action) {
      case "list":       return listDevices(params, ctx.abortSignal)
      case "hid-list":   return hidList(ctx.abortSignal)
      default:           return { success: false, error: `未知操作: ${action}` }
    }
  },
})

// ══════════════════════════════════════════════════
// 设备枚举
// ══════════════════════════════════════════════════

async function listDevices(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const filterVid = params.vid as string | undefined
  const filterPid = params.pid as string | undefined
  if ((filterVid && !/^[0-9a-fA-F]{4}$/.test(filterVid)) || (filterPid && !/^[0-9a-fA-F]{4}$/.test(filterPid))) {
    return { success: false, error: "vid/pid 必须是 4 位十六进制字符串" }
  }
  const platform = process.platform

  try {
    if (platform === "win32") {
      // Windows: 使用 PowerShell 枚举 USB 设备
      const psScript = `
        Get-PnPDevice -Class USB | 
        Select-Object InstanceId, FriendlyName, Status |
        ConvertTo-Json -Compress
      `
      const allResult = await runProcess(
        ["powershell", "-Command", psScript],
        { signal, timeoutMs: 15_000 },
      )
      if (allResult.exitCode !== 0) return { success: false, error: allResult.stderr || "USB 枚举失败" }
      const output = allResult.stdout
      const devices = filterUsbDevices(tryParseJson(output), filterVid, filterPid)

      return {
        success: true,
        data: {
          platform: "windows",
          devices,
          tip: "在 Tauri 环境中由 Rust rusb crate 提供更详细的设备信息。",
        },
      }
    }

    if (platform === "linux") {
      // Linux: lsusb
      const result = await runProcess(["lsusb"], { signal, timeoutMs: 15_000 })
      if (result.exitCode !== 0) return { success: false, error: result.stderr || "lsusb 执行失败" }
      const output = result.stdout
      const devices = parseLsusb(output).filter((device) => matchesUsbFilter(device.id, filterVid, filterPid))

      return {
        success: true,
        data: {
          platform: "linux",
          devices,
        },
      }
    }

    return {
      success: true,
      data: {
        platform,
        tip: `平台 ${platform} 的 USB 枚举由 Tauri Rust 后端处理。CLI 环境请使用系统工具。`,
      },
    }
  } catch (err) {
    return { success: false, error: `USB 枚举失败: ${err}` }
  }
}

// ══════════════════════════════════════════════════
// HID 设备列表
// ══════════════════════════════════════════════════

async function hidList(signal?: AbortSignal): Promise<ToolResult> {
  const platform = process.platform

  if (platform === "win32") {
    try {
      const psScript = `
        Get-PnPDevice -Class HIDClass |
        Select-Object InstanceId, FriendlyName, Status |
        ConvertTo-Json -Compress
      `
      const result = await runProcess(["powershell", "-Command", psScript], { signal, timeoutMs: 15_000 })
      return result.exitCode === 0
        ? { success: true, data: { hidDevices: tryParseJson(result.stdout) ?? result.stdout } }
        : { success: false, error: result.stderr || "HID 枚举失败" }
    } catch (err) {
      return { success: false, error: `HID 枚举失败: ${err}` }
    }
  }

  return { success: true, data: { tip: "HID 设备枚举由 Tauri Rust 后端处理" } }
}

// ══════════════════════════════════════════════════
// 解析辅助
// ══════════════════════════════════════════════════

interface UsbDevice {
  bus: string; device: string; id: string; vendor: string; product: string
}

function parseLsusb(output: string): UsbDevice[] {
  const devices: UsbDevice[] = []
  for (const line of output.split("\n")) {
    const match = line.match(/^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s+(.+)$/i)
    if (match) {
      devices.push({
        bus: match[1], device: match[2],
        id: `${match[3]}:${match[4]}`,
        vendor: match[3], product: match[5],
      })
    }
  }
  return devices
}

function tryParseJson(str: string): unknown | null {
  try { return JSON.parse(str) } catch { return null }
}

function matchesUsbFilter(value: string, vid?: string, pid?: string): boolean {
  const normalized = value.toUpperCase()
  return (!vid || normalized.includes(vid.toUpperCase())) && (!pid || normalized.includes(pid.toUpperCase()))
}

function filterUsbDevices(value: unknown, vid?: string, pid?: string): unknown[] {
  const devices = Array.isArray(value) ? value : value ? [value] : []
  return devices.filter((device) => matchesUsbFilter(JSON.stringify(device), vid, pid))
}
