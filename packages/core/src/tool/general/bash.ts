import { defineTool } from "../define"
import { safePath } from "../helpers"
import { executeShellCommand } from "../shell-executor.ts"
import {
  authorizeShellProcess,
  inspectShellCommand,
} from "../../runtime/process-capability-broker.ts"
import type { ToolEffect } from "../types.ts"
import {
  attestSuccessfulCommand,
  type RequestedCommandVerifier,
} from "../../runtime/command-verification-adapter.ts"

export const bashTool = defineTool({
  name: "bash",
  description: "执行命令行任务。Windows 真正使用 PowerShell，请直接写 PowerShell/原生命令，不要再嵌套 powershell -Command；工作区文件移动/重命名优先使用 move。运行时会按用户权限自动执行或显示审批，禁止把可执行命令甩给用户手动运行。编译命令会自动把实时输出发送到编译 Tab，也可通过 outputTarget 明确指定。普通命令默认超时 60 秒，脚本/安装任务默认 30 分钟，也可通过 timeoutMs 指定（最长 30 分钟）；输出截断至 50KB。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      cwd:     { type: "string", description: "工作目录（默认为当前工作空间）" },
      outputTarget: { type: "string", enum: ["terminal", "build"], description: "实时日志目标；构建命令请使用 build，省略时自动识别" },
      timeoutMs: { type: "integer", minimum: 1_000, maximum: 1_800_000, description: "命令超时毫秒数；预计较久的安装、渲染、测试任务请显式设置，最长 30 分钟" },
      verification: {
        type: "string",
        enum: ["process", "build", "test", "regression-test", "stress-test"],
        description: "仅在本命令是结构化验收条件的验证器时填写；类型必须与 TaskContract criterion.verifier 一致",
      },
    },
    required: ["command"],
  },
  async execute({ command, cwd, outputTarget, timeoutMs, verification }: {
    command: string
    cwd?: string
    outputTarget?: "terminal" | "build"
    timeoutMs?: number
    verification?: RequestedCommandVerifier
  }, ctx) {
    const workDir = cwd ? safePath(ctx.workingDir, cwd) : safePath(ctx.workingDir, ".")
    const stream = ctx.streamOutput
    const streamTarget = resolveBashOutputTarget(command, outputTarget)
    const processDecision = authorizeShellProcess(command, workDir)
    if (!processDecision.allowed) {
      const summary = processDecision.reason ?? "命令超出通用 shell 的进程能力边界"
      stream?.(streamTarget, `[进程能力] ${summary}`, "stderr")
      return {
        success: false,
        error: summary,
        data: {
          status: "process-capability-denied",
          capabilities: processDecision.findings.map((finding) => ({
            capability: finding.capability,
            executable: finding.executable,
          })),
        },
        outcome: {
          status: "failed",
          category: "permission",
          summary,
          fingerprint: `process-capability:${processDecision.findings
            .map((finding) => `${finding.capability}:${finding.executable}`)
            .join(",")}`,
          diagnostic: {
            kind: "process-capability-denied",
            evidence: processDecision.findings.map((finding) =>
              `${finding.executable}: ${finding.capability} (${finding.reason})`),
            nextActions: processDecision.findings.some((finding) => finding.capability === "embedded-build")
              ? ["ESP-IDF 项目请改用 compile 工具；非 ESP 项目只能在用户自备厂商环境中手动编译"]
              : ["使用 read、grep、glob 等具名工具完成诊断，或选择具备所需效果的专用工具"],
          },
        },
      }
    }
    try {
      const result = await executeShellCommand(command, {
        cwd: workDir,
        timeoutMs: resolveBashTimeoutMs(command, timeoutMs),
        signal: ctx.abortSignal,
        maxOutputChars: 50_000,
        onLine: (line, type) => stream?.(streamTarget, line, type),
      })
      const success = result.exitCode === 0 && !result.timedOut && !result.aborted
      return {
        success,
        data: { output: result.output, exitCode: result.exitCode, outputTarget: streamTarget, diagnostics: result.diagnostics, diagnostic: result.diagnostic },
        error: success ? undefined : result.summary,
        outcome: {
          status: result.aborted ? "cancelled" : result.timedOut ? "timed-out" : success ? "succeeded" : "failed",
          category: streamTarget === "build" ? "build" : "command",
          summary: result.summary,
          fingerprint: result.fingerprint,
          exitCode: result.exitCode,
          evidence: success
            ? attestSuccessfulCommand({
                command,
                cwdTarget: cwd || ".",
                requested: verification,
              })
            : undefined,
          diagnostic: result.diagnostic,
        },
      }
    } catch (err: any) {
      const summary = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        error: summary,
        outcome: { status: "failed", category: streamTarget === "build" ? "build" : "command", summary, fingerprint: `bash: ${summary}` },
      }
    }
  },
  // An unsandboxed general shell can exercise every host-side effect. Declare
  // the conservative superset so a terminal grant cannot launder other denies.
  contract: {
    effects: ["workspace-read", "workspace-write", "process", "network", "hardware"],
    alwaysEffects: ["process"],
    idempotency: "unknown",
    cancellation: "process-tree",
    progress: { role: "dynamic", targetParameters: ["cwd"] },
  },
  resolveAuthorizationEffects: resolveBashAuthorizationEffects,
  permission: "bash",
})

const SHORT_COMMAND_TIMEOUT_MS = 60_000
const LONG_COMMAND_TIMEOUT_MS = 30 * 60_000

export function resolveBashTimeoutMs(command: string, requested?: number): number {
  if (Number.isFinite(requested)) {
    return Math.min(LONG_COMMAND_TIMEOUT_MS, Math.max(1_000, Math.round(requested!)))
  }
  const firstInvocation = command.trim().split(/[;|&\r\n]/, 1)[0]?.trim() ?? ""
  return /(?:^|[\\/])[^\\/\s]+\.(?:ps1|cmd|bat|py|js|mjs|cjs)(?:\s|$)|^(?:winget|choco|scoop|npm|npx|pnpm|yarn|bun|pip|pip3)\b/i
    .test(firstInvocation)
    ? LONG_COMMAND_TIMEOUT_MS
    : SHORT_COMMAND_TIMEOUT_MS
}

const ALL_BASH_EFFECTS: readonly ToolEffect[] = [
  "workspace-read",
  "workspace-write",
  "process",
  "network",
  "hardware",
]

export function resolveBashAuthorizationEffects(input: Record<string, unknown>): readonly ToolEffect[] {
  const command = typeof input.command === "string" ? input.command.trim() : ""
  if (!command) return ALL_BASH_EFFECTS
  const findings = inspectShellCommand(command, process.cwd())
  if (findings.some((finding) =>
    finding.capability === "opaque-process" || finding.capability === "general-process")) {
    return ALL_BASH_EFFECTS
  }
  const effects = new Set<ToolEffect>(["process"])
  for (const finding of findings) {
    if (finding.capability === "diagnostic") effects.add("workspace-read")
    if (finding.capability === "embedded-build") {
      effects.add("workspace-read")
      effects.add("workspace-write")
    }
    if (finding.capability === "network") {
      effects.add("workspace-read")
      effects.add("workspace-write")
      effects.add("network")
    }
    if (finding.capability === "hardware") {
      effects.add("workspace-read")
      effects.add("hardware")
    }
  }
  return [...effects]
}

export function resolveBashOutputTarget(command: string, requested?: "terminal" | "build"): "terminal" | "build" {
  if (requested) return requested
  const buildCommand = /(?:^|[;&|]\s*)(?:call\s+)?(?:make(?:\.exe)?(?:\s|$)|mingw32-make(?:\.exe)?(?:\s|$)|ninja(?:\.exe)?(?:\s|$)|cmake(?:\.exe)?\s+(?:--build|-S|-B)|(?:arm-none-eabi-)?(?:gcc|g\+\+|clang|clang\+\+)(?:\.exe)?(?:\s|$)|cargo\s+(?:build|check|test)|(?:pnpm|npm|yarn)\s+(?:run\s+)?(?:build|test)|bun\s+(?:run\s+)?(?:build|test))/i
  return buildCommand.test(command.trim()) ? "build" : "terminal"
}
