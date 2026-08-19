/**
 * serial_open 工具 — 串口终端
 * 通过 eval-serial Rust CLI 工具实现跨平台串口 I/O
 */
import { defineTool } from "../define.ts"
import type { ToolResult } from "../types.ts"
import { serialList, serialOpen as _serialOpen, serialSend as _serialSend, serialReceive as _serialReceive, serialMonitor, hasSerialBin } from "./serial-port.ts"

export const serialOpenTool = defineTool({
  name: "serial_open",
  description: `打开串口连接并交互。

功能：
- 列出可用串口
- 打开指定串口（波特率/数据位/停止位/校验位）
- 发送数据
- 接收数据（超时控制）
- 关闭串口

常用波特率：9600, 115200, 921600, 1000000
常用配置：8N1 (8数据位, 无校验, 1停止位)

参数：
- port: 串口名称 (如 COM3, /dev/ttyUSB0)
- baudRate: 波特率 (默认 115200)
- action: 操作类型 (list/open/send/receive/close)
- data: 发送的数据 (action=send 时使用)
- timeout: 接收超时毫秒数 (默认 3000)`,

  permission: "serial",
  parameters: {
    type: "object",
    properties: {
      port: { type: "string", description: "串口名称" },
      baudRate: { type: "number", description: "波特率" },
      dataBits: { type: "number", description: "数据位" },
      parity: { type: "string", enum: ["none", "even", "odd"], description: "校验位" },
      stopBits: { type: "number", description: "停止位" },
      action: { type: "string", enum: ["list", "open", "send", "receive", "close"], description: "操作类型" },
      data: { type: "string", description: "发送的数据" },
      timeout: { type: "number", description: "超时毫秒数" },
    },
    required: ["action"],
  },

  contract: {
    effects: ["hardware"],
    idempotency: "non-idempotent",
    cancellation: "unsupported",
    progress: { role: "control", targetParameters: ["port"] },
  },

  async execute(params, _ctx): Promise<ToolResult> {
    const action = params.action as string

    switch (action) {
      case "list": {
        if (!hasSerialBin()) return { success: false, error: "eval-serial 未安装。构建: cd tools/eval-serial && cargo build --release" }
        const r = serialList()
        return r.success ? { success: true, data: (r.data as any)?.data } : { success: false, error: r.error }
      }
      case "open": {
        const port = params.port as string
        const baudRate = (params.baudRate as number) ?? 115200
        if (!port) return { success: false, error: "缺少 port 参数" }
        const r = _serialOpen(port, baudRate)
        return r.success ? { success: true, data: (r.data as any)?.data } : { success: false, error: r.error }
      }
      case "send": {
        const port = params.port as string
        const baudRate = (params.baudRate as number) ?? 115200
        const data = params.data as string
        if (!port || !data) return { success: false, error: "缺少 port 或 data 参数" }
        const r = _serialSend(port, baudRate, data)
        return r.success ? { success: true, data: (r.data as any)?.data } : { success: false, error: r.error }
      }
      case "receive": {
        const port = params.port as string
        const baudRate = (params.baudRate as number) ?? 115200
        const timeout = (params.timeout as number) ?? 3000
        if (!port) return { success: false, error: "缺少 port 参数" }
        const r = _serialReceive(port, baudRate, timeout)
        return r.success ? { success: true, data: (r.data as any)?.data } : { success: false, error: r.error }
      }
      case "close":
        return { success: true, data: { closed: params.port ?? "unknown" } }
      default:
        return { success: false, error: `未知操作: ${action}` }
    }
  },
})

export const serialMonitorTool = defineTool({
  name: "serial_monitor",
  description: `持续监控串口输出。

功能：
- 实时接收串口数据并逐行输出
- 适合长时间调试监控
- 可通过 duration 参数控制监控时长`,

  permission: "serial",
  parameters: {
    type: "object",
    properties: {
      port: { type: "string", description: "串口名称" },
      baudRate: { type: "number", description: "波特率 (默认 115200)" },
      duration: { type: "number", description: "监控时长秒数 (默认 30)" },
    },
    required: ["port"],
  },

  contract: {
    effects: ["hardware"],
    idempotency: "read-only",
    cancellation: "cooperative",
    progress: { role: "verification", targetParameters: ["port"], verificationScope: "targeted" },
  },

  async execute(params, ctx): Promise<ToolResult> {
    const port = params.port as string
    const baudRate = (params.baudRate as number) ?? 115200
    const duration = (params.duration as number) ?? 30
    if (!port) return { success: false, error: "缺少 port 参数" }
    if (!hasSerialBin()) return { success: false, error: "eval-serial 未安装" }

    const lines: string[] = []
    try {
      for await (const line of serialMonitor(port, baudRate, duration, ctx.abortSignal)) {
        if (lines.length < 10_000) lines.push(line)
        // 实时推送每行到前端底部面板"串口"tab
        ctx.streamOutput?.("serial", line, "info")
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }

    return {
      success: true,
      data: { port, baudRate, lines, count: lines.length },
    }
  },
})
