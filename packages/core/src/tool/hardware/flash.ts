import { defineTool } from "../define.ts"
import type { ToolResult } from "../types.ts"
import { flashEspBundle, resolveEspDownloadTarget } from "./esptool-service"
import { findProjectRoot } from "../../store/project-config"

/**
 * Agent-facing ESP firmware download tool.
 *
 * Download addresses and image membership come exclusively from the latest
 * certified ESP-IDF flasher_args.json. Models cannot provide raw addresses,
 * filenames or arbitrary esptool commands.
 */
export const flashTool = defineTool({
  name: "flash",
  description: `通过 USB 或 UART 将经过认证的 ESP-IDF 固件包下载到 ESP 芯片。

前置条件：
- 项目目标在芯片注册表中明确声明 Espressif + ESP-IDF + esptool 元数据
- 最近一次成功构建认证了 flasher_args.json 中的全部 BIN、偏移和哈希
- 用户选择 USB Serial/JTAG、USB CDC、USB-UART 或 UART 端口
- esptool 在写入前识别出的真实芯片必须与项目 target 一致

工具强制执行写后校验。Eval 不提供非 ESP 芯片的内置下载；其他芯片仍可编写程序，
但需使用对应厂商工具手动下载。`,
  permission: "flash",
  parameters: {
    type: "object",
    properties: {
      port: { type: "string", description: "ESP USB/UART 下载端口，如 COM7 或 /dev/ttyACM0" },
      baud: { type: "number", description: "UART/USB-UART 下载波特率，默认 460800" },
      bundleId: { type: "string", description: "可选的 ESP 认证固件包 ID，用于拒绝过期产物" },
      verify: { type: "boolean", description: "必须为 true；下载后执行 Flash 校验" },
    },
    required: ["port"],
  },
  contract: {
    effects: ["workspace-read", "process", "hardware"],
    idempotency: "non-idempotent",
    cancellation: "cooperative",
    progress: { role: "verification", targetParameters: ["port"], verificationScope: "global" },
  },
  async execute(params, ctx): Promise<ToolResult> {
    const root = findProjectRoot(ctx.workingDir) ?? ctx.workingDir
    try {
      resolveEspDownloadTarget(root)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (typeof params.port !== "string" || !params.port.trim()) {
      return { success: false, error: "ESP 下载必须选择 USB 或 UART 端口" }
    }
    if (params.verify === false) {
      return { success: false, error: "ESP 固件下载不允许关闭写后校验" }
    }
    try {
      const result = await flashEspBundle({
        projectRoot: root,
        port: params.port,
        baud: typeof params.baud === "number" ? params.baud : undefined,
        bundleId: typeof params.bundleId === "string" ? params.bundleId : undefined,
        verify: true,
        signal: ctx.abortSignal,
        onLine: (line, type) => ctx.streamOutput?.("build", line, type),
      })
      return {
        success: true,
        data: {
          programmer: "esptool",
          chip: result.chip,
          port: result.port,
          transport: result.connection.transport,
          bundleId: result.bundleId,
          programmedBytes: result.programmedBytes,
          verified: result.verified,
          verificationEvidence: result.verificationEvidence,
        },
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
})
