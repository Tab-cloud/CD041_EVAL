import { runProcess, type ProcessResult } from "./process.ts"
import { diagnoseBuildFailure, diagnosticFingerprint } from "./build-diagnostics.ts"
import type { ToolDiagnostic } from "./types.ts"

export interface ShellExecutionOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputChars?: number
  onLine?: (line: string, type: "stdout" | "stderr") => void
}

export interface ShellExecutionResult extends ProcessResult {
  output: string
  diagnostics: string[]
  diagnostic?: ToolDiagnostic
  summary: string
  fingerprint?: string
}

/** Execute a shell command through the platform transport adapter. */
export async function executeShellCommand(command: string, options: ShellExecutionOptions): Promise<ShellExecutionResult> {
  const invocation = buildShellInvocation(command, options.cwd)
  const result = await runProcess(invocation, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    maxOutputChars: options.maxOutputChars,
    onLine: options.onLine,
  })
  const output = combineProcessOutput(result.stdout, result.stderr)
  const diagnostics = result.exitCode === 0 && !result.timedOut && !result.aborted
    ? []
    : diagnoseCommandFailure(output)
  const diagnostic = result.exitCode === 0 || result.timedOut || result.aborted
    ? undefined
    : diagnoseBuildFailure(output)
  const summary = summarizeShellResult(result, output, diagnostics, diagnostic)
  return {
    ...result,
    output,
    diagnostics,
    diagnostic,
    summary,
    fingerprint: result.exitCode === 0 && !result.timedOut && !result.aborted
      ? undefined
      : diagnostic ? diagnosticFingerprint(diagnostic) : buildShellFailureFingerprint(summary, output),
  }
}

/**
 * Bun on Windows can corrupt non-ASCII command arguments. Use an encoded
 * PowerShell envelope so the documented command language and the actual
 * executor are identical while command text and cwd cross the boundary
 * losslessly.
 */
export function buildShellInvocation(command: string, cwd: string, platform = process.platform): string[] {
  if (platform !== "win32") return ["/bin/sh", "-lc", command]
  const commandPayload = Buffer.from(command, "utf8").toString("base64")
  const cwdPayload = Buffer.from(cwd, "utf8").toString("base64")
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$utf8 = [Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = $utf8",
    "$OutputEncoding = $utf8",
    "$ErrorActionPreference = 'Stop'",
    `$command = $utf8.GetString([Convert]::FromBase64String('${commandPayload}'))`,
    `$cwd = $utf8.GetString([Convert]::FromBase64String('${cwdPayload}'))`,
    "Set-Location -LiteralPath $cwd",
    "$status = 1",
    "try { $global:LASTEXITCODE = $null; & ([ScriptBlock]::Create($command)); $commandSucceeded = $?; $nativeExitCode = $LASTEXITCODE; $status = if ($null -ne $nativeExitCode) { [int]$nativeExitCode } elseif ($commandSucceeded) { 0 } else { 1 } } catch { [Console]::Error.WriteLine($_.ToString()); $status = 1 }",
    "exit $status",
  ].join("; ")
  const encodedScript = Buffer.from(script, "utf16le").toString("base64")
  // Script execution has already crossed Eval's user-configured authorization
  // boundary. A process-local bypass prevents Windows execution-policy defaults
  // from turning an approved tool call back into a manual terminal handoff.
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", encodedScript]
}

export function diagnoseCommandFailure(output: string): string[] {
  const diagnostics: string[] = []
  if (/subdirectory or file -p already exists|processing:\s*-p/i.test(output)) {
    diagnostics.push("当前命令使用了不兼容 Windows PowerShell 的 `mkdir -p`；改用 `New-Item -ItemType Directory -Force <dir>` 或 `cmake -E make_directory <dir>`。")
  }
  if (/missing filename after ['"]?-o|fatal error: no input files/i.test(output)) {
    diagnostics.push("编译命令的输出路径和输入文件展开为空。检查 Make 自动变量；在 define/eval 生成的 recipe 中使用 `$$@`、`$$<`，或改用显式规则并先执行 `make -n`。")
  }
  if (/expected ['"]?\(['"]? before ['"]?void|stray ['"]?#['"]? in program/i.test(output) && /__ASM|SUBS\s+r0|BNE\s+/i.test(output)) {
    diagnostics.push("当前 C 源文件包含 Keil/ARMCC 内联汇编语法，却由 GCC 编译。应切换到厂商 GCC 参考工程中的对应 system 源文件，并加入其独立汇编辅助文件；不要混用 ARMCC 与 GCC SDK 变体。")
  }
  if (/(?:'FLASH'|FLASH_AC_LATEN_0).+undeclared|FLASH_AC_LATEN_0.+undeclared/is.test(output)) {
    diagnostics.push("当前自定义 SystemInit 使用了与 N32WB03x GCC 头文件不匹配的 FLASH 寄存器定义。不要继续手写 sys.c；直接复用厂商 GCC 工程的 CMSIS/device/system_n32wb03x.c 与 system_delay.s，并保持同一 GCC SDK 的 include 路径。")
  }
  if (/No rule to make target ['"]?([^'"\r\n]+)['"]?/i.test(output)) {
    diagnostics.push("Makefile 引用了不存在或无法访问的源文件。先用 glob/目录读取核对目标的真实路径和大小写；若结构化文件工具确认存在而 CMD 仍报不存在，应判定为命令编码或路径传递问题，不要重复执行同一条 make。")
  }
  return diagnostics
}

function combineProcessOutput(stdout: string, stderr: string): string {
  return [stdout.trimEnd(), stderr ? `\n[stderr]\n${stderr.trimEnd()}` : ""].join("").trim() || "(无输出)"
}

function summarizeShellResult(result: ProcessResult, output: string, diagnostics: string[], diagnostic?: ToolDiagnostic): string {
  if (result.aborted) return "命令执行已取消"
  if (result.timedOut) return "命令执行超时"
  if (result.exitCode === 0) return "命令执行成功"
  if (diagnostic) return diagnostic.evidence[0] ?? diagnostic.kind
  if (diagnostics.length > 0) return diagnostics[0]
  const important = output.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /(?:fatal )?error:|undefined reference|undeclared|not recognized|No rule to make target|cannot find|找不到/i.test(line))
  return important || `命令退出码 ${result.exitCode}`
}

function buildShellFailureFingerprint(summary: string, output: string): string {
  const evidence = summary.startsWith("命令退出码 ") ? `${summary}\n${output}` : summary
  return evidence
    .replace(/[A-Z]:[/\\][^:\r\n]+/gi, "<path>")
    .replace(/:\d+(?::\d+)?/g, ":#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}
