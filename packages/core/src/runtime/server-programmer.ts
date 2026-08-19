import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import {
  connectEspTarget,
  flashEspBundle,
  getEspToolStatus,
  installEsptool,
  resolveEspDownloadTarget,
} from "../tool/hardware/esptool-service"
import { OrchestrationLogRepo } from "../store/orchestration-log"
import { getSystemSettings } from "./system-settings"
import { json } from "./server-response"

/**
 * Download API boundary.
 *
 * This router intentionally has one provider and one artifact contract:
 * ESP-IDF flasher_args.json -> esptool -> USB/UART transport. J-Link/J-Flash,
 * arbitrary HEX files and model-supplied addresses are not accepted.
 */
export async function handleProgrammerRoute(
  req: Request,
  url: URL,
  cors: Record<string, string>,
): Promise<Response | null> {
  if (url.pathname === "/api/programmer/status" && req.method === "GET") {
    const projectDir = validProjectDir(url.searchParams.get("projectDir"))
    if (!projectDir) return json({ error: "projectDir 不是有效目录" }, { ...cors, status: 400 })
    try {
      resolveEspDownloadTarget(projectDir)
      const hardwareAllowed = getSystemSettings().toolPolicies.hardware !== "deny"
      const detectPorts = hardwareAllowed && url.searchParams.get("ports") === "1"
      const status = await getEspToolStatus(projectDir, { detectPorts })
      if (!hardwareAllowed) status.blockers.unshift("系统设置已禁用硬件访问")
      return json(status, cors)
    } catch (error) {
      return json({ error: message(error) }, { ...cors, status: 409 })
    }
  }

  if (url.pathname === "/api/programmer/install-esptool" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    if (body.confirmed !== true) {
      return json({ error: "安装 Python 包会修改当前用户环境，必须由用户明确确认" }, { ...cors, status: 409 })
    }
    const projectDir = validProjectDir(body.projectDir)
    if (!projectDir) return json({ error: "projectDir 不是有效目录" }, { ...cors, status: 400 })
    try {
      resolveEspDownloadTarget(projectDir)
    } catch (error) {
      return json({ error: message(error) }, { ...cors, status: 409 })
    }
    if (getSystemSettings().toolPolicies.hardware === "deny") {
      return json({ error: "系统设置已禁用硬件访问" }, { ...cors, status: 403 })
    }
    const existing = await getEspToolStatus(projectDir, { detectPorts: false }).catch(() => null)
    if (existing?.installation) return json({ error: "esptool 已安装，无需重复安装" }, { ...cors, status: 409 })
    return streamOperation(req, cors, async (emit, signal) => {
      const result = await installEsptool({
        signal,
        onLine: (line, type) => emit({ event: "output", text: line, type }),
      })
      emit({ event: "complete", text: `esptool ${result.version ?? ""} 安装完成` })
    })
  }

  if (url.pathname === "/api/programmer/connect" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const projectDir = validProjectDir(body.projectDir)
    if (!projectDir) return json({ error: "projectDir 不是有效目录" }, { ...cors, status: 400 })
    try {
      resolveEspDownloadTarget(projectDir)
    } catch (error) {
      return json({ error: message(error) }, { ...cors, status: 409 })
    }
    if (getSystemSettings().toolPolicies.hardware === "deny") {
      return json({ error: "系统设置已禁用硬件访问" }, { ...cors, status: 403 })
    }
    if (typeof body.port !== "string") return json({ error: "port 无效" }, { ...cors, status: 400 })
    try {
      const result = await connectEspTarget({
        projectRoot: projectDir,
        port: body.port,
        signal: req.signal,
      })
      return json({ result }, cors)
    } catch (error) {
      return json({ error: message(error) }, { ...cors, status: 502 })
    }
  }

  if (url.pathname === "/api/programmer/flash" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const projectDir = validProjectDir(body.projectDir)
    if (!projectDir) return json({ error: "projectDir 不是有效目录" }, { ...cors, status: 400 })
    try {
      resolveEspDownloadTarget(projectDir)
    } catch (error) {
      return json({ error: message(error) }, { ...cors, status: 409 })
    }
    if (getSystemSettings().toolPolicies.hardware === "deny") {
      return json({ error: "系统设置已禁用硬件访问" }, { ...cors, status: 403 })
    }
    if (body.confirmed !== true) {
      return json({ error: "下载会修改目标芯片，必须由用户明确确认" }, { ...cors, status: 409 })
    }
    if (typeof body.port !== "string") return json({ error: "port 无效" }, { ...cors, status: 400 })
    if (body.verify === false) {
      return json({ error: "ESP 固件下载不允许关闭写后校验" }, { ...cors, status: 409 })
    }
    const sessionId = typeof body.sessionId === "string" && body.sessionId.length <= 160
      ? body.sessionId
      : "programmer"
    const runId = `esp-flash-${randomUUID()}`
    return streamOperation(req, cors, async (emit, signal) => {
      audit(sessionId, runId, "programmer.esp-flash.started", "info", "用户已确认 ESP USB/UART 下载", {
        projectDir, port: body.port, bundleId: body.bundleId,
      })
      try {
        const result = await flashEspBundle({
          projectRoot: projectDir,
          port: body.port as string,
          baud: typeof body.baud === "number" ? body.baud : undefined,
          bundleId: typeof body.bundleId === "string" ? body.bundleId : undefined,
          verify: true,
          signal,
          onLine: (line, type) => emit({ event: "output", text: line, type }),
        })
        audit(sessionId, runId, "programmer.esp-flash.completed", "info", "ESP 下载及校验完成", {
          bundleId: result.bundleId,
          chip: result.chip,
          port: result.port,
          transport: result.connection.transport,
          programmedBytes: result.programmedBytes,
        })
        emit({ event: "complete", result })
      } catch (error) {
        const aborted = signal.aborted
        audit(
          sessionId,
          runId,
          aborted ? "programmer.esp-flash.cancelled" : "programmer.esp-flash.failed",
          aborted ? "warning" : "error",
          aborted ? "ESP 下载已取消" : "ESP 下载失败",
          { error: message(error) },
        )
        throw error
      }
    })
  }

  return null
}

function streamOperation(
  req: Request,
  cors: Record<string, string>,
  operation: (
    emit: (data: Record<string, unknown>) => void,
    signal: AbortSignal,
  ) => Promise<void>,
): Response {
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  req.signal.addEventListener("abort", abort, { once: true })
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const emit = (data: Record<string, unknown>) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)) } catch {}
      }
      try {
        await operation(emit, abortController.signal)
      } catch (error) {
        emit({
          event: abortController.signal.aborted ? "cancelled" : "error",
          error: message(error),
        })
      } finally {
        req.signal.removeEventListener("abort", abort)
        try { controller.close() } catch {}
      }
    },
    cancel() { abortController.abort() },
  })
  return new Response(stream, {
    status: 200,
    headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  })
}

function validProjectDir(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) return null
  try {
    const path = resolve(value)
    return statSync(path).isDirectory() ? path : null
  } catch {
    return null
  }
}

function audit(
  sessionId: string,
  runId: string,
  eventType: string,
  level: "info" | "warning" | "error",
  messageText: string,
  data: Record<string, unknown>,
): void {
  try {
    OrchestrationLogRepo.insert({
      sessionId,
      runId,
      eventType,
      level,
      message: messageText,
      data,
    })
  } catch {
    // Download execution must not fail solely because diagnostics persistence is unavailable.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
