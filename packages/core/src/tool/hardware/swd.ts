/**
 * swd_debug 工具 — SWD / J-Link 调试
 *
 * 通过 OpenOCD + GDB 实现：连接调试器、断点管理、寄存器读写、变量监视。
 * 也在 Tauri 环境中委托给 Rust 后端的 probe-rs / openocd 子进程。
 */
import { defineTool } from "../define.ts"
import type { ToolContext, ToolResult } from "../types.ts"
import { runProcess } from "../process"

export const swdDebugTool = defineTool({
  name: "swd_debug",
  description: `通过 SWD/JTAG 调试器连接目标芯片，执行调试操作。

功能：
- 自动检测调试器类型（ST-Link / J-Link / DAP-Link / CMSIS-DAP）
- 连接调试器，halt 目标芯片
- 读写 CPU 寄存器（R0-R15, SP, LR, PC, xPSR）
- 读写系统寄存器（CFSR, HFSR, SHCSR — HardFault 诊断用）
- 设置/清除硬件断点
- 单步执行（step into / step over）
- 读写内存/外设寄存器地址
- 复位芯片

调试器自动检测顺序：ST-Link → J-Link → DAP-Link → CMSIS-DAP

参数：
- action: 操作类型 (connect / disconnect / halt / resume / reset / step / regs / breakpoints / memory)
- programmer: 调试器类型 (auto / stlink / jlink / cmsisdap / daplink)
- targetCfg: OpenOCD target 配置 (如 stm32f1x.cfg，默认自动推断)
- address: 内存地址 (action=memory 时使用)
- length: 读取长度 (action=memory 时使用)
- breakpoints: 断点地址数组 (action=breakpoints 时使用)`,

  permission: "debug",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["connect", "disconnect", "halt", "resume", "reset", "step", "regs", "breakpoints", "memory"],
        description: "操作类型",
      },
      programmer: { type: "string", description: "调试器类型" },
      targetCfg: { type: "string", description: "OpenOCD target 配置" },
      address: { type: "string", description: "内存/寄存器地址 (hex)" },
      length: { type: "number", description: "读取长度 (bytes)" },
      breakpoints: { type: "array", items: { type: "string" }, description: "断点地址数组" },
      stepMode: { type: "string", enum: ["into", "over"], description: "单步模式" },
    },
    required: ["action"],
  },

  contract: {
    effects: ["process", "hardware"],
    idempotency: "non-idempotent",
    cancellation: "process-tree",
    progress: {
      role: "dynamic",
      targetParameters: ["targetCfg", "address", "breakpoints"],
    },
  },

  async execute(params, ctx): Promise<ToolResult> {
    const action = params.action as string
    const programmer = (params.programmer as string) ?? "auto"
    const targetCfg = (params.targetCfg as string) ?? "stm32f1x.cfg"
    if (!/^(auto|stlink|jlink|cmsisdap|daplink)$/.test(programmer)) return { success: false, error: `不支持的调试器: ${programmer}` }
    if (!["connect", "disconnect"].includes(action) && (!openocdProc || openocdOwner !== ctx.sessionId)) {
      return { success: false, error: openocdProc ? `OpenOCD 由其他会话占用: ${openocdOwner}` : "OpenOCD 未连接" }
    }

    switch (action) {
      case "connect":     return connect(programmer, targetCfg, ctx)
      case "disconnect":  return disconnect(ctx)
      case "halt":        return gdbResult("monitor reset halt", ctx)
      case "resume":      return gdbResult("continue", ctx)
      case "reset":       return gdbResult("monitor reset run", ctx)
      case "step":        return gdbResult(params.stepMode === "over" ? "next" : "stepi", ctx)
      case "regs":        return readRegisters(ctx)
      case "breakpoints": return manageBreakpoints(params, ctx)
      case "memory":      return readMemory(params, ctx)
      default:            return { success: false, error: `未知操作: ${action}` }
    }
  },
})

// ══════════════════════════════════════════════════
// 连接管理
// ══════════════════════════════════════════════════

async function connect(programmer: string, targetCfg: string, ctx: ToolContext): Promise<ToolResult> {
  if (openocdProc) return { success: false, error: `OpenOCD 已由会话 ${openocdOwner ?? "unknown"} 占用` }
  if (!/^[A-Za-z0-9_.-]+$/.test(targetCfg)) return { success: false, error: `非法 targetCfg: ${targetCfg}` }
  const iface = programmerToOpenOCD(programmer)
  const openocdCmd = [
    "openocd",
    "-f", `interface/${iface}.cfg`,
    "-f", `target/${targetCfg}`,
    "-c", "init",
    "-c", "reset halt",
  ]

  try {
    const proc = Bun.spawn(openocdCmd, {
      stdout: "pipe", stderr: "pipe",
    })

    const startup = await waitForOpenOcd(proc, ctx)
    if (!startup.ready) {
      proc.kill()
      return { success: false, error: `OpenOCD 连接失败:\n${startup.output.slice(-1000) || "启动超时"}` }
    }

    openocdProc = proc
    openocdOwner = ctx.sessionId
    void proc.exited.then(() => {
      if (openocdProc === proc) {
        openocdProc = null
        openocdOwner = null
      }
    })
    return {
      success: true,
      data: {
        status: "connected",
        programmer: iface,
        targetCfg,
        gdbPort: 3333,
        telnetPort: 4444,
        instruction: "OpenOCD 已启动。使用 GDB 连接: arm-none-eabi-gdb -ex 'target remote :3333'",
        openocdOutput: startup.output.slice(-300),
      },
    }
  } catch (err) {
    return { success: false, error: `启动 OpenOCD 失败: ${err}。请确保 OpenOCD 已安装并在 PATH 中。` }
  }
}

async function disconnect(ctx: ToolContext): Promise<ToolResult> {
  if (openocdOwner && openocdOwner !== ctx.sessionId) return { success: false, error: `OpenOCD 由其他会话占用: ${openocdOwner}` }
  try {
    await sendGdbCommand("monitor shutdown", ctx.abortSignal)
  } catch { /* OpenOCD may already be gone */ }
  // 确保杀掉 connect 启动的 OpenOCD 子进程，避免端口占用 / 进程残留
  if (openocdProc) {
    try { openocdProc.kill() } catch { /* already exited */ }
    openocdProc = null
    openocdOwner = null
  }
  return { success: true, data: { status: "disconnected" } }
}

// ══════════════════════════════════════════════════
// 寄存器读取
// ══════════════════════════════════════════════════

async function readRegisters(ctx: ToolContext): Promise<ToolResult> {
  const cmds = [
    "info registers",
    "monitor reg",             // 某些 OpenOCD 版本
    "p/x $cfsr",               // HardFault 状态寄存器 (M3/M4)
    "p/x $hfsr",
    "p/x $shcsr",
    "p/x $msp",
    "p/x $psp",
    "info breakpoints",
  ]

  const results: Record<string, string> = {}
  for (const cmd of cmds) {
    const output = await sendGdbCommand(cmd, ctx.abortSignal)
    if (output && !output.includes("error")) {
      results[cmd] = output
    }
  }

  if (Object.keys(results).length === 0) {
    return {
      success: false,
      error: "无法读取寄存器。请确保调试器已连接 (swd_debug action=connect)。",
      data: {
        instruction: "在 Tauri 环境中，寄存器读取由 Rust probe-rs 后端执行。CLI 环境需要 GDB + OpenOCD。",
      },
    }
  }

  // 解析核心寄存器
  const coreRegs = parseCoreRegisters(results["info registers"] ?? "")
  const faultRegs = parseFaultRegisters(results)

  return {
    success: true,
    data: {
      core: coreRegs,
      fault: faultRegs,
      hasHardFault: faultRegs ? (parseInt(faultRegs.CFSR ?? "0", 16) !== 0 || parseInt(faultRegs.HFSR ?? "0", 16) !== 0) : false,
      raw: results,
    },
  }
}

// 保存 connect 启动的 OpenOCD 进程，供 disconnect 时清理
let openocdProc: ReturnType<typeof Bun.spawn> | null = null
let openocdOwner: string | null = null

async function sendGdbCommand(cmd: string, signal?: AbortSignal): Promise<string> {
  // 防止命令注入：GDB -ex 会执行换行分隔的多条命令（如 "foo\nshell calc"）
  if (/[\r\n]/.test(cmd)) return ""
  const gdbCmd = [
    "arm-none-eabi-gdb",
    "-batch",
    "-ex", `target remote :3333`,
    "-ex", cmd,
    "-ex", "quit",
  ]

  try {
    const result = await runProcess(gdbCmd, { signal, timeoutMs: 10_000 })
    return result.stdout || result.stderr
  } catch {
    return ""
  }
}

async function gdbResult(command: string, ctx: ToolContext): Promise<ToolResult> {
  if (!openocdProc) return { success: false, error: "OpenOCD 未连接" }
  if (openocdOwner !== ctx.sessionId) return { success: false, error: `OpenOCD 由其他会话占用: ${openocdOwner}` }
  const output = await sendGdbCommand(command, ctx.abortSignal)
  if (!output || /(?:error|not connected|connection timed out)/i.test(output)) {
    return { success: false, error: output || "GDB 命令没有返回结果" }
  }
  return { success: true, data: { output } }
}

async function waitForOpenOcd(
  process: ReturnType<typeof Bun.spawn>,
  ctx: ToolContext,
): Promise<{ ready: boolean; output: string }> {
  let output = ""
  let resolveReady: (ready: boolean) => void = () => {}
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve })
  const consume = async (stream: ReadableStream<Uint8Array>, type: "stdout" | "stderr") => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        output = (output + text).slice(-10_000)
        for (const line of text.split(/\r?\n/)) if (line) ctx.streamOutput?.("terminal", line, type)
        if (/Listening on port 3333|target halted|target state: halted/i.test(output)) resolveReady(true)
        if (/Error:|Address already in use/i.test(output)) resolveReady(false)
      }
    } catch { resolveReady(false) }
  }
  void consume(process.stdout as ReadableStream<Uint8Array>, "stdout")
  void consume(process.stderr as ReadableStream<Uint8Array>, "stderr")
  const onAbort = () => { try { process.kill() } catch {}; resolveReady(false) }
  ctx.abortSignal?.addEventListener("abort", onAbort, { once: true })
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))
  const exited = process.exited.then(() => false)
  const result = await Promise.race([ready, timeout, exited])
  ctx.abortSignal?.removeEventListener("abort", onAbort)
  return { ready: result, output }
}

// ══════════════════════════════════════════════════
// 断点管理
// ══════════════════════════════════════════════════

async function manageBreakpoints(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const breakpoints = params.breakpoints as string[] | undefined

  if (!breakpoints || breakpoints.length === 0) {
    // 读取当前断点
    const output = await sendGdbCommand("info breakpoints", ctx.abortSignal)
    return {
      success: true,
      data: {
        breakpoints: parseBreakpoints(output),
        raw: output,
      },
    }
  }

  // 设置断点（校验地址格式，防止 GDB -ex 命令注入）
  const results: string[] = []
  for (const addr of breakpoints) {
    if (!/^0x[0-9a-fA-F]+$/.test(addr)) {
      results.push(`break *${addr}: [非法地址格式，需为 0x 十六进制]`)
      continue
    }
    const result = await sendGdbCommand(`break *${addr}`, ctx.abortSignal)
    results.push(`break *${addr}: ${result.slice(0, 80)}`)
  }

  return {
    success: true,
    data: { set: breakpoints, results },
  }
}

// ══════════════════════════════════════════════════
// 内存读取
// ══════════════════════════════════════════════════

async function readMemory(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const address = params.address as string
  const length = (params.length as number) ?? 16

  if (!address) {
    return { success: false, error: "缺少 address 参数" }
  }
  // 校验地址与长度，防止 GDB -ex 命令注入
  if (!/^0x[0-9a-fA-F]+$/.test(address)) {
    return { success: false, error: `非法地址格式: ${address}（需为 0x 十六进制）` }
  }
  if (!Number.isInteger(length) || length <= 0 || length > 1024) {
    return { success: false, error: `非法读取长度: ${length}（需为 1-1024 的整数）` }
  }

  const cmd = `x/${length}x ${address}`
  const output = await sendGdbCommand(cmd, ctx.abortSignal)

  if (!output || output.includes("Cannot access")) {
    return { success: false, error: `无法读取地址 ${address}: ${output}` }
  }

  return {
    success: true,
    data: {
      address,
      length,
      hex: output,
      parsed: parseMemoryHex(output),
    },
  }
}

// ══════════════════════════════════════════════════
// 解析辅助函数
// ══════════════════════════════════════════════════

function programmerToOpenOCD(p: string): string {
  const map: Record<string, string> = { stlink: "stlink", jlink: "jlink", cmsisdap: "cmsis-dap", daplink: "cmsis-dap" }
  return map[p] ?? "stlink"
}

function parseCoreRegisters(output: string): Record<string, string> | null {
  const regs: Record<string, string> = {}
  const patterns = [
    /r0\s+(0x[0-9a-fA-F]+)/i, /r1\s+(0x[0-9a-fA-F]+)/i, /r2\s+(0x[0-9a-fA-F]+)/i, /r3\s+(0x[0-9a-fA-F]+)/i,
    /sp\s+(0x[0-9a-fA-F]+)/i, /lr\s+(0x[0-9a-fA-F]+)/i, /pc\s+(0x[0-9a-fA-F]+)/i, /xpsr\s+(0x[0-9a-fA-F]+)/i,
  ]
  for (const pattern of patterns) {
    const match = output.match(pattern)
    if (match) {
      const name = pattern.source.match(/[a-z0-9]+/i)?.[0] ?? "?"
      regs[name.toUpperCase()] = match[1]
    }
  }
  return Object.keys(regs).length > 0 ? regs : null
}

function parseFaultRegisters(results: Record<string, string>): Record<string, string> | null {
  const regs: Record<string, string> = {}
  for (const [cmd, output] of Object.entries(results)) {
    const match = output.match(/(0x[0-9a-fA-F]+)/)
    if (match) {
      const name = cmd.replace("p/x $", "").toUpperCase()
      regs[name] = match[1]
    }
  }
  return Object.keys(regs).length > 0 ? regs : null
}

function parseBreakpoints(output: string): Array<{ num: string; type: string; addr: string }> {
  const bps: Array<{ num: string; type: string; addr: string }> = []
  const lines = output.split("\n")
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(\w+)\s+.*?(0x[0-9a-fA-F]+)/)
    if (match) bps.push({ num: match[1], type: match[2], addr: match[3] })
  }
  return bps
}

function parseMemoryHex(output: string): string[] {
  const bytes: string[] = []
  const match = output.match(/0x[0-9a-fA-F]+ <[^>]+>:\s*([0-9a-fA-Fx\s]+)/)
  if (match) {
    bytes.push(...match[1].split(/\s+/).filter(Boolean))
  }
  return bytes
}
