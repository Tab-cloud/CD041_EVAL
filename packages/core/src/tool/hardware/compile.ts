import { existsSync, statSync } from "node:fs"
import { defineTool } from "../define"
import type { ToolEvidenceAttestation, ToolResult } from "../types"
import { safePath } from "../helpers"
import {
  buildConfigFromContext,
  createBuildRequest,
  formatBuildTargetLabel,
} from "../../runtime/build-context"
import {
  evaluateBuildTargetGuard,
  persistConfirmedBuildFamily,
  persistConfirmedBuildTarget,
} from "../../runtime/build-target-guard"
import { executeBuildRequest, toolStreamAdapter } from "./build-runner"
import type { BuildMode, BuildRunManifest } from "./build-types"

export { formatBuildTargetLabel } from "../../runtime/build-context"

export const compileTool = defineTool({
  name: "compile",
  description: `编译 Espressif ESP 系列的原生 ESP-IDF 工程。

当前产品边界仅支持芯片库中明确声明 Espressif + ESP-IDF + esptool 平台元数据的芯片。
编译器、链接脚本、分区表和产物由 ESP-IDF 工程负责；工具不会根据型号前缀猜测目标。
每次执行都会生成不可变 BuildRequest 和构建清单，并分别报告：
- 构建进程结果
- 本次产生或可信复用的固件产物
- 固件下载资格

参数：
- projectDir: 构建工程目录
- target: 构建目标，默认 all
- mode: incremental / rebuild / clean
- jobs: 1-32
- toolchain: 已保留为请求兼容字段，但不会覆盖 ESP-IDF 工具链`,

  permission: "compile",
  parameters: {
    type: "object",
    properties: {
      projectDir: { type: "string", minLength: 1, description: "项目目录" },
      target: { type: "string", minLength: 1, maxLength: 128, description: "后端目标，默认 all" },
      mode: { type: "string", enum: ["incremental", "rebuild", "clean"], description: "构建模式" },
      toolchain: { type: "string", maxLength: 512, description: "可选工具链前缀，仅用于尺寸分析" },
      jobs: { type: "integer", minimum: 1, maximum: 32, description: "并行数" },
    },
    required: ["projectDir"],
    additionalProperties: false,
  },

  contract: {
    effects: ["workspace-read", "workspace-write", "process"],
    idempotency: "unknown",
    cancellation: "process-tree",
    progress: { role: "verification", targetParameters: ["projectDir"], verificationScope: "targeted" },
  },

  async execute(params, ctx): Promise<ToolResult> {
    let projectDir: string
    try {
      projectDir = safePath(ctx.workingDir, String(params.projectDir))
    } catch {
      return failed(`项目目录越权: ${params.projectDir}`, "build-path-outside-workspace")
    }
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      return failed(`项目目录不存在: ${projectDir}`, "build-project-not-found")
    }

    if (ctx.resolvedUserInteraction?.type === "target-confirmation") {
      const confirmation = persistConfirmedBuildTarget(projectDir, ctx.resolvedUserInteraction.answer)
      if (!confirmation.success) return confirmation
      ctx.streamOutput?.("build", `[目标校验] 已确认 ${ctx.resolvedUserInteraction.answer}，恢复同一构建请求。`, "info")
    } else if (ctx.resolvedUserInteraction?.type === "target-family-confirmation") {
      const confirmation = persistConfirmedBuildFamily(projectDir, ctx.resolvedUserInteraction.answer)
      if (!confirmation.success) return confirmation
      ctx.streamOutput?.("build", `[目标校验] 已确认底层芯片族 ${ctx.resolvedUserInteraction.answer}，恢复同一构建请求。`, "info")
    }

    let config
    try {
      config = buildConfigFromContext(projectDir, {
        target: typeof params.target === "string" ? params.target : undefined,
        jobs: typeof params.jobs === "number" ? params.jobs : undefined,
        toolchain: typeof params.toolchain === "string" ? params.toolchain : undefined,
        mode: typeof params.mode === "string" ? params.mode as BuildMode : undefined,
      })
    } catch (error) {
      return failed(message(error), "build-configuration-invalid")
    }

    const targetGate = evaluateBuildTargetGuard(projectDir, config, { sessionId: ctx.sessionId })
    if (targetGate) {
      ctx.streamOutput?.("build", `[目标校验] ${targetGate.error ?? "目标芯片尚未确认"}`, "stderr")
      return targetGate
    }

    let request
    try {
      request = createBuildRequest(config)
    } catch (error) {
      return failed(message(error), "build-request-invalid")
    }
    ctx.streamOutput?.(
      "build",
      `[构建请求 ${request.requestId.slice(0, 8)}] 项目: ${request.projectName}  芯片: ${formatBuildTargetLabel(config)}  后端: ${request.buildSystem} (${request.buildSystemSource})`,
      "info",
    )

    try {
      const manifest = await executeBuildRequest(request, {
        signal: ctx.abortSignal,
        onEvent: toolStreamAdapter(ctx),
      })
      return resultFromManifest(manifest)
    } catch (error) {
      return failed(`构建执行器异常: ${message(error)}`, "build-runner-failed")
    }
  },
})

export function resultFromManifest(manifest: BuildRunManifest): ToolResult {
  const succeeded = manifest.process.status === "succeeded"
  const cleaned = manifest.request.mode === "clean"
  const firmware = manifest.artifacts.find((artifact) => artifact.format === "hex" && artifact.valid)
  const summary = succeeded
    ? firmware
      ? `构建成功；已认证 ${firmware.relativePath}`
      : manifest.request.mode === "clean"
        ? "清理成功"
        : "构建成功；没有可认证的 HEX 产物"
    : manifest.process.status === "cancelled"
      ? "构建已取消"
      : manifest.process.status === "timed-out"
        ? "构建超时"
        : `构建失败（退出码 ${manifest.process.exitCode ?? "未知"}）`
  const evidence: ToolEvidenceAttestation[] | undefined = succeeded
    ? [
        {
          kind: "process-verification",
          targets: [manifest.request.projectDir],
          producer: "build-runner",
        },
        ...(!cleaned ? [{
          kind: "build-success" as const,
          targets: [manifest.request.projectDir],
          producer: "build-manifest",
        }] : []),
      ]
    : undefined
  return {
    success: succeeded,
    error: succeeded ? undefined : summary,
    data: manifest,
    outcome: {
      status: manifest.process.status === "succeeded"
        ? "succeeded"
        : manifest.process.status === "cancelled"
          ? "cancelled"
          : manifest.process.status === "timed-out"
            ? "timed-out"
            : "failed",
      category: cleaned ? "command" : "build",
      summary,
      evidence,
      exitCode: manifest.process.exitCode,
      fingerprint: `build:${manifest.request.projectDir}:${manifest.process.status}:${manifest.process.exitCode ?? "none"}:${manifest.process.diagnostics[0]?.message ?? ""}`,
      diagnostic: succeeded ? undefined : {
        kind: `build-${manifest.process.status}`,
        evidence: manifest.process.diagnostics.slice(0, 20).map((item) => item.message),
        nextActions: manifest.process.status === "failed"
          ? ["根据结构化诊断修复构建输入", "重新执行同一项目的编译验证"]
          : manifest.process.status === "timed-out"
            ? ["检查是否存在挂起的构建步骤", "必要时在项目配置中调整有界构建超时"]
            : ["用户取消后不自动重放本次构建"],
      },
    },
  }
}

function failed(error: string, kind: string): ToolResult {
  return {
    success: false,
    error,
    outcome: {
      status: "failed",
      category: "build",
      summary: error,
      fingerprint: `${kind}:${error}`,
      diagnostic: { kind, evidence: [error], nextActions: ["修正构建配置后重新执行"] },
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
