import { mkdirSync } from "node:fs"
import type { ToolContext } from "../types"
import { runProcess } from "../process"
import { compilerCandidateRoots, findExecutable, resolveBuildPrerequisites } from "../../runtime/build-prerequisites"
import { createBuildPlan } from "./build-backends"
import {
  buildManifest,
  resolveBuildArtifacts,
  saveBuildManifest,
  snapshotBuildArtifacts,
} from "./build-manifest"
import type {
  BuildDiagnostic,
  BuildEvent,
  BuildProcessOutcome,
  BuildRequest,
  BuildRunManifest,
  BuildStreamType,
} from "./build-types"
import { buildExecutionGate } from "./build-execution-gate"

export interface BuildRunnerOptions {
  signal?: AbortSignal
  onEvent?: (event: BuildEvent) => void
}

export async function executeBuildRequest(
  request: BuildRequest,
  options: BuildRunnerOptions = {},
): Promise<BuildRunManifest> {
  const release = await buildExecutionGate.acquire(options.signal)
  try {
    return await executeBuildRequestWithSlot(request, options)
  } finally {
    release()
  }
}

async function executeBuildRequestWithSlot(
  request: BuildRequest,
  options: BuildRunnerOptions,
): Promise<BuildRunManifest> {
  mkdirSync(request.buildDir, { recursive: true })
  const before = snapshotBuildArtifacts(request.buildDir)
  const plan = createBuildPlan(request)
  const started = Date.now()
  const stdout: string[] = []
  const stderr: string[] = []
  const diagnostics: BuildDiagnostic[] = []
  let exitCode = 0
  let status: BuildProcessOutcome["status"] = "succeeded"

  for (const step of plan.steps) {
    emit(options, request, step.phase, "info", `[${phaseLabel(step.phase)}] ${step.command.join(" ")}`)
    const resolved = resolveBuildPrerequisites(configView(request), step.command)
    for (const item of resolved.found) emit(options, request, "resolve", "info", `[环境] ${item.name}: ${item.path}`)
    if (resolved.missing.length) {
      status = "failed"
      exitCode = -1
      const message = `缺少构建后端: ${resolved.missing.join(", ")}`
      diagnostics.push({ severity: "error", message })
      stderr.push(message)
      emit(options, request, "resolve", "stderr", message)
      break
    }
    const result = await runProcess(resolved.command, {
      cwd: request.projectDir,
      env: resolved.env,
      signal: options.signal,
      timeoutMs: request.timeoutMs,
      maxOutputChars: 200_000,
      onLine: (line, type) => {
        appendTail(type === "stderr" ? stderr : stdout, line)
        diagnostics.push(...parseDiagnosticLine(line))
        emit(options, request, step.phase, type, line)
      },
    })
    exitCode = result.exitCode
    if (result.aborted) status = "cancelled"
    else if (result.timedOut) status = "timed-out"
    else if (result.exitCode !== 0) status = "failed"
    if (status !== "succeeded") break
  }

  let artifacts = status === "succeeded" && request.mode !== "clean"
    ? await resolveBuildArtifacts(request, before)
    : []
  let sections: BuildRunManifest["sections"]
  if (status === "succeeded") {
    sections = await readSections(request, artifacts.find((artifact) => artifact.format === "elf")?.path, options)
  }
  const process: BuildProcessOutcome = {
    status,
    exitCode,
    commands: plan.steps.map((step) => ({ phase: step.phase, command: step.command })),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    diagnostics: uniqueDiagnostics(diagnostics),
    stdoutTail: stdout.slice(-200).join("\n"),
    stderrTail: stderr.slice(-200).join("\n"),
  }
  const manifest = buildManifest(request, process, artifacts, sections)
  saveBuildManifest(manifest)
  emit(options, request, "complete", status === "succeeded" ? "info" : "stderr", summary(manifest))
  return manifest
}

export function toolStreamAdapter(ctx: ToolContext): BuildRunnerOptions["onEvent"] {
  return (event) => ctx.streamOutput?.("build", event.text, event.type)
}

function configView(request: BuildRequest) {
  return {
    projectDir: request.projectDir,
    projectRoot: request.projectRoot,
    projectName: request.projectName,
    buildDir: request.buildDir,
    buildSystem: request.buildSystem,
    buildSystemSource: request.buildSystemSource,
    toolchain: request.toolchain,
    chipModel: request.targetSnapshot.model,
    chipFamily: request.targetSnapshot.family,
    chipEvidence: request.targetSnapshot.evidence,
    chipSource: "project-config" as const,
    target: request.target,
    jobs: request.jobs,
    timeoutMs: request.timeoutMs,
    mode: request.mode,
    configurePreset: request.configurePreset,
    buildPreset: request.buildPreset,
    generator: request.generator,
    toolchainFile: request.toolchainFile,
  }
}

async function readSections(
  request: BuildRequest,
  elfPath: string | undefined,
  options: BuildRunnerOptions,
): Promise<BuildRunManifest["sections"]> {
  if (!elfPath || !request.toolchain) return undefined
  const name = `${request.toolchain}size`
  const executable = findExecutable(name, process.env, compilerCandidateRoots(process.env))
  if (!executable) return undefined
  const result = await runProcess([executable, elfPath], {
    cwd: request.projectDir,
    signal: options.signal,
    timeoutMs: Math.min(request.timeoutMs, 30_000),
    maxOutputChars: 20_000,
    onLine: (line, type) => emit(options, request, "post-process", type, line),
  })
  if (result.exitCode !== 0 || result.aborted || result.timedOut) return undefined
  return parseSizeOutput(result.stdout)
}

function emit(
  options: BuildRunnerOptions,
  request: BuildRequest,
  phase: BuildEvent["phase"],
  type: BuildStreamType,
  text: string,
): void {
  options.onEvent?.({ requestId: request.requestId, phase, type, text, timestamp: Date.now() })
}

function appendTail(lines: string[], line: string): void {
  lines.push(line)
  if (lines.length > 500) lines.splice(0, lines.length - 500)
}

function parseDiagnosticLine(line: string): BuildDiagnostic[] {
  const compiler = line.match(/^(.+?):(\d+)(?::(\d+))?:\s+(fatal error|error|warning):\s+(.+)$/i)
  if (compiler) {
    return [{
      severity: /warning/i.test(compiler[4]) ? "warning" : "error",
      file: compiler[1],
      line: Number(compiler[2]),
      column: compiler[3] ? Number(compiler[3]) : undefined,
      message: compiler[5],
    }]
  }
  if (/undefined reference|collect2(?:\.exe)?: error|(?:^|[/\\])ld(?:\.exe)?:|ninja: build stopped|cmake error/i.test(line)) {
    return [{ severity: "error", message: line.trim() }]
  }
  return []
}

function uniqueDiagnostics(values: BuildDiagnostic[]): BuildDiagnostic[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = JSON.stringify(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 500)
}

function parseSizeOutput(output: string): BuildRunManifest["sections"] {
  for (const line of output.trim().split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 4 && parts.slice(0, 4).every((part) => /^\d+$/.test(part))) {
      return {
        text: `${parts[0]} B`,
        data: `${parts[1]} B`,
        bss: `${parts[2]} B`,
        total: `${parts[3]} B`,
      }
    }
  }
  return undefined
}

function summary(manifest: BuildRunManifest): string {
  const artifact = manifest.artifacts.find((item) => item.format === "hex" && item.valid)
  if (manifest.process.status !== "succeeded") return `构建${statusLabel(manifest.process.status)}`
  if (manifest.request.mode === "clean") return "清理完成"
  return artifact
    ? `构建完成，HEX ${artifact.relativePath}，SHA-256 ${artifact.sha256.slice(0, 12)}`
    : "构建完成；本次没有可认证的 HEX 固件"
}

function phaseLabel(phase: BuildEvent["phase"]): string {
  const labels: Record<BuildEvent["phase"], string> = {
    resolve: "解析", configure: "配置", clean: "清理", build: "编译",
    "post-process": "后处理", verify: "验证", complete: "完成",
  }
  return labels[phase]
}

function statusLabel(status: BuildProcessOutcome["status"]): string {
  if (status === "cancelled") return "已取消"
  if (status === "timed-out") return "超时"
  if (status === "failed") return "失败"
  return "完成"
}
