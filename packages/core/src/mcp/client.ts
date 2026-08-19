import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

export interface McpClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>
  notify(method: string, params?: unknown): Promise<void>
  close(): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024

export class StdioMcpClient implements McpClient {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, PendingRequest>()
  private nextId = 1

  constructor(command: string, args: string[], cwd: string | undefined, env: Record<string, string>, private timeoutMs: number) {
    this.child = spawn(command, args, {
      cwd, shell: false, windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => this.handleLine(line))
    this.child.stderr.resume()
    this.child.once("error", (error) => this.rejectAll(error))
    this.child.once("exit", (code) => this.rejectAll(new Error(`MCP 进程已退出 (${code ?? "unknown"})`)))
  }

  request(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: "2.0", id, method, params })
    })
  }

  async notify(method: string, params: unknown = {}): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params })
  }

  close(): void {
    this.rejectAll(new Error("MCP 连接已关闭"))
    this.child.kill()
  }

  private write(value: unknown): void {
    if (!this.child.stdin.writable) throw new Error("MCP 标准输入不可写")
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
      if (typeof message.id !== "number") return
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? "MCP 请求失败"))
      else pending.resolve(message.result)
    } catch { /* MCP 日志行不是 JSON 时忽略 */ }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export class HttpMcpClient implements McpClient {
  private nextId = 1
  private sessionId = ""

  constructor(private url: string, private headers: Record<string, string>, private timeoutMs: number) {}

  async request(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<any> {
    const response = await this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, timeoutMs)
    if (response.error) throw new Error(response.error.message ?? "MCP 请求失败")
    return response.result
  }

  async notify(method: string, params: unknown = {}): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params })
  }

  close(): void {}

  private async send(body: unknown, timeoutMs = this.timeoutMs): Promise<any> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId
    const text = await readLimitedText(response, MAX_HTTP_RESPONSE_BYTES)
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter((line) => line && line !== "[DONE]").at(-1)
      return data ? JSON.parse(data) : {}
    }
    return text ? JSON.parse(text) : {}
  }
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {})
    throw new Error("MCP HTTP 响应过大")
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error("MCP HTTP 响应过大")
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
  }
}
