/**
 * serial-port.ts — Serial port helper using eval-serial CLI
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

function findSerialBin(): string | null {
  // 1. 环境变量
  if (process.env.EVAL_SERIAL_BIN) return process.env.EVAL_SERIAL_BIN
  // 2. 与 eval-server 同目录
  const exeDir = process.argv0 ? resolve(process.argv0, "..") : process.cwd()
  const candidates = [
    resolve(exeDir, "eval-serial.exe"),
    resolve(exeDir, "eval-serial"),
    resolve(process.cwd(), "tools", "eval-serial", "target", "release", "eval-serial.exe"),
    resolve(process.cwd(), "tools", "eval-serial", "target", "release", "eval-serial"),
    resolve(process.cwd(), "target", "release", "eval-serial.exe"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function execSerial(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const bin = findSerialBin()
  if (!bin) {
    return { stdout: "", stderr: "eval-serial binary not found. Build with: cd tools/eval-serial && cargo build --release", exitCode: 1 }
  }
  const r = spawnSync(bin, args, { timeout: 35000, encoding: "utf-8", maxBuffer: 1024 * 1024 })
  return {
    stdout: r.stdout?.trim() ?? "",
    stderr: r.stderr?.trim() || r.error?.message || "",
    exitCode: r.status ?? 1,
  }
}

function parseSerialResult(r: ReturnType<typeof execSerial>): { success: boolean; data?: unknown; error?: string } {
  let parsed: any
  try { parsed = r.stdout ? JSON.parse(r.stdout) : null } catch {}
  if (r.exitCode !== 0 || parsed?.success === false) {
    return { success: false, error: parsed?.error || r.stderr || r.stdout || `eval-serial 退出码 ${r.exitCode}` }
  }
  if (!parsed || parsed.success !== true) return { success: false, error: "eval-serial 返回了无效响应" }
  return { success: true, data: parsed }
}

export function serialList(): { success: boolean; data?: unknown; error?: string } {
  return parseSerialResult(execSerial(["list"]))
}

export function serialOpen(port: string, baudRate: number): { success: boolean; data?: unknown; error?: string } {
  return parseSerialResult(execSerial(["open", port, String(baudRate)]))
}

export function serialSend(port: string, baudRate: number, data: string): { success: boolean; data?: unknown; error?: string } {
  return parseSerialResult(execSerial(["send", port, String(baudRate), data]))
}

export function serialReceive(port: string, baudRate: number, timeoutMs: number): { success: boolean; data?: unknown; error?: string } {
  return parseSerialResult(execSerial(["receive", port, String(baudRate), String(timeoutMs)]))
}

/** 返回生成器函数 — 监控串口输出 */
export async function* serialMonitor(port: string, baudRate: number, durationSecs: number, signal?: AbortSignal): AsyncGenerator<string> {
  const bin = findSerialBin()
  if (!bin) {
    yield JSON.stringify({ error: "eval-serial binary not found" })
    return
  }
  const duration = Math.max(1, Math.min(Math.floor(durationSecs), 3600))
  const proc = Bun.spawn([bin, "monitor", port, String(baudRate), String(duration)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.getReader()
  const stderrPromise = new Response(proc.stderr).text()
  const onAbort = () => { try { proc.kill() } catch {} }
  signal?.addEventListener("abort", onAbort, { once: true })
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let event: any
        try { event = JSON.parse(line) } catch { throw new Error(`eval-serial 返回无效 JSON: ${line.slice(0, 200)}`) }
        if (event.success === false) throw new Error(event.error || "串口监控失败")
        if (typeof event.data?.line === "string") yield event.data.line
      }
    }
    const exitCode = await proc.exited
    const stderr = await stderrPromise
    if (signal?.aborted) throw Object.assign(new Error("串口监控已取消"), { name: "AbortError" })
    if (exitCode !== 0) throw new Error(stderr.trim() || `eval-serial 退出码 ${exitCode}`)
  } finally {
    // 消费者提前退出或异常时，杀掉子进程并释放 reader，避免端口占用 / 进程残留
    try { proc.kill() } catch {}
    signal?.removeEventListener("abort", onAbort)
    try { await reader.cancel() } catch {}
  }
}

export function hasSerialBin(): boolean {
  return findSerialBin() !== null
}
