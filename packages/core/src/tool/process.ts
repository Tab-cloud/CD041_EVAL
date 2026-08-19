export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

interface ProcessOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputChars?: number
  onLine?: (line: string, type: "stdout" | "stderr") => void
}

export async function runProcess(command: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  if (options.signal?.aborted) throw abortError()
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
  const limit = options.maxOutputChars ?? 100_000
  let timedOut = false
  const kill = () => terminateProcessTree(child)
  const onAbort = () => kill()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => { timedOut = true; kill() }, options.timeoutMs ?? 60_000)

  try {
    const stdout = { value: "" }
    const stderr = { value: "" }
    const [exitCode] = await Promise.all([
      child.exited,
      drain(child.stdout, stdout, "stdout", limit, options.onLine),
      drain(child.stderr, stderr, "stderr", limit, options.onLine),
    ])
    return {
      exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      timedOut,
      aborted: options.signal?.aborted ?? false,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}

function terminateProcessTree(child: Bun.Subprocess): void {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
    } catch {}
    try { child.kill() } catch {}
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    try { child.kill() } catch {}
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  output: { value: string },
  type: "stdout" | "stderr",
  limit: number,
  onLine?: (line: string, type: "stdout" | "stderr") => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) {
        if (output.value.length < limit) output.value += `${line}\n`.slice(0, limit - output.value.length)
        onLine?.(line, type)
      }
    }
    if (pending) {
      if (output.value.length < limit) output.value += pending.slice(0, limit - output.value.length)
      onLine?.(pending, type)
    }
  } finally {
    reader.releaseLock()
  }
}

function abortError(): Error {
  const error = new Error("进程执行已取消")
  error.name = "AbortError"
  return error
}
