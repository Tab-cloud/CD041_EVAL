import { auditToolExecutionContract } from "../src/runtime/runtime-capability-audit.ts"
import { evaluateToolAuthorization } from "../src/runtime/tool-policy.ts"
import { globTool } from "../src/tool/fs/index.ts"
import { resultFromManifest } from "../src/tool/hardware/compile.ts"
import type { BuildRunManifest } from "../src/tool/hardware/build-types.ts"
import { chipAddTool } from "../src/tool/hardware/chip-add.ts"
import { swdDebugTool } from "../src/tool/hardware/swd.ts"
import { usbTool } from "../src/tool/hardware/usb.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import { datasheetReadTool } from "../src/tool/schematic/datasheet-read.ts"
import { schematicReadTool } from "../src/tool/schematic/schematic-read.ts"
import { EMBEDDED_TOOLS } from "../src/tool/tools-index.ts"
import type { AgentDefinition } from "../src/agent/types.ts"
import type { ToolDefinition } from "../src/tool/types.ts"

describe("strong tool contracts", () => {
  test("all built-in target parameters exist in their JSON schemas", () => {
    const reports = EMBEDDED_TOOLS.map((tool) => ({
      name: tool.name,
      ...auditToolExecutionContract(tool),
    }))
    expect(reports.flatMap((report) => report.errors.map((error) => `${report.name}: ${error}`)))
      .toEqual([])
  })

  test("startup audit rejects schema drift and unsafe read-only actions", () => {
    const missingTarget = fixtureTool({
      progress: { role: "inspection", targetParameters: ["missingPath"] },
    })
    expect(auditToolExecutionContract(missingTarget).errors.join("\n"))
      .toContain("目标参数 missingPath 不存在于参数 Schema")

    const unsafeAction = fixtureTool({
      effects: ["hardware"],
      idempotency: "read-only",
      progress: { role: "inspection" },
      actionEnum: ["list", "flash"],
    })
    const errors = auditToolExecutionContract(unsafeAction).errors.join("\n")
    expect(errors).toContain("危险动作 flash 不能声明为 read-only")
    expect(errors).toContain("危险动作 flash 不能声明为 inspection")

    const invalidMinimum = fixtureTool({
      effects: ["process"],
      alwaysEffects: ["hardware"],
    })
    expect(auditToolExecutionContract(invalidMinimum).errors.join("\n"))
      .toContain("alwaysEffects 必须是 effects 的子集")
  })

  test("delegated resource boundaries authorize real schema targets", () => {
    expect(authorize(globTool, { patterns: ["src/**/*.ts"] }, ["src/**"])).toEqual({ action: "allow" })
    expect(authorize(schematicReadTool, { filePath: "docs/board.pdf" }, ["docs/**"]))
      .toEqual({ action: "allow" })
    expect(authorize(datasheetReadTool, {
      filePath: "docs/chip.pdf",
      compareWith: "docs/chip-b.pdf",
    }, ["docs/**"])).toEqual({ action: "allow" })
    expect(authorize(chipAddTool, {
      model: "ESP32-S3",
      catalogPath: ".eval/chips.json",
    }, [], [".eval/**"])).toEqual({ action: "allow" })

    // SWD no longer pretends OpenOCD target names are workspace paths.
    expect(authorize(swdDebugTool, { action: "regs" }, []))
      .toEqual({ action: "allow" })
  })

  test("usb_detect rejects legacy DFU and reset actions before execution", async () => {
    const registry = new ToolRegistry()
    registry.register(usbTool)
    const context = {
      sessionId: "usb-contract",
      agentId: "main-agent",
      workingDir: process.cwd(),
    }
    for (const action of ["dfu-flash", "dfu-detach", "reset"]) {
      const result = await registry.execute("usb_detect", { action }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain("工具参数无效")
    }
    expect((usbTool.parameters.properties as any).firmwarePath).toBeUndefined()
  })

  test("schema failures share one bounded native-tool repair contract", async () => {
    const registry = new ToolRegistry()
    registry.register(usbTool)
    const context = {
      sessionId: "schema-repair-contract",
      agentId: "main-agent",
      workingDir: process.cwd(),
    }

    const unsupportedAction = await registry.execute(
      "usb_detect",
      { action: "dfu-flash" },
      context,
    )
    const wrongShape = await registry.execute(
      "usb_detect",
      { action: ["list"] },
      context,
    )

    for (const result of [unsupportedAction, wrongShape]) {
      expect(result.outcome?.fingerprint).toBe("tool-input-invalid:usb_detect")
      expect(result.outcome?.diagnostic?.kind).toBe("tool-input-invalid")
      expect(result.outcome?.diagnostic?.recoveryCandidates).toEqual([
        expect.objectContaining({
          id: "repair-native-tool-input",
          steps: [expect.objectContaining({
            tools: ["usb_detect"],
            effects: [],
          })],
        }),
      ])
    }
  })

  test("clean success proves only process completion, never build success", () => {
    const clean = resultFromManifest(buildManifest("clean"))
    expect(clean.outcome?.category).toBe("command")
    expect(clean.outcome?.evidence?.map((item) => item.kind))
      .toEqual(["process-verification"])

    const build = resultFromManifest(buildManifest("incremental"))
    expect(build.outcome?.category).toBe("build")
    expect(build.outcome?.evidence?.map((item) => item.kind))
      .toEqual(["process-verification", "build-success"])
  })
})

function authorize(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  reads: string[],
  writes: string[] = [],
) {
  const agent: AgentDefinition = {
    id: "contract-test",
    name: "contract-test",
    description: "contract-test",
    mode: "hidden",
    requiredCapabilities: ["reasoning"],
    tools: [tool.name],
    permissions: [{ permission: tool.permission, pattern: "*", effect: "allow" }],
    systemPrompt: "",
    maxSteps: 1,
  }
  return evaluateToolAuthorization(
    agent,
    tool,
    new Set([tool.name]),
    "full-access",
    input,
    undefined,
    { workingDir: process.cwd(), resources: { reads, writes } },
  )
}

function fixtureTool(overrides: {
  effects?: ToolDefinition["contract"]["effects"]
  alwaysEffects?: ToolDefinition["contract"]["alwaysEffects"]
  idempotency?: ToolDefinition["contract"]["idempotency"]
  progress?: ToolDefinition["contract"]["progress"]
  actionEnum?: string[]
}): ToolDefinition {
  return {
    name: "fixture",
    description: "fixture",
    permission: "fixture",
    parameters: {
      type: "object",
      properties: overrides.actionEnum
        ? { path: { type: "string" }, action: { type: "string", enum: overrides.actionEnum } }
        : { path: { type: "string" } },
    },
    contract: {
      effects: overrides.effects ?? ["workspace-read"],
      alwaysEffects: overrides.alwaysEffects,
      idempotency: overrides.idempotency ?? "read-only",
      cancellation: "unsupported",
      progress: overrides.progress ?? { role: "inspection" },
    },
    async execute() {
      return { success: true }
    },
  }
}

function buildManifest(mode: "incremental" | "clean"): BuildRunManifest {
  return {
    schemaVersion: 1,
    request: {
      schemaVersion: 1,
      requestId: `request-${mode}`,
      createdAt: "2026-07-29T00:00:00.000Z",
      projectDir: "H:/workspace/esp-demo",
      projectRoot: "H:/workspace/esp-demo",
      projectName: "esp-demo",
      buildDir: "H:/workspace/esp-demo/build",
      buildSystem: "idf",
      buildSystemSource: "project-config",
      mode,
      target: "all",
      jobs: 4,
      timeoutMs: 60_000,
      toolchain: "",
      platformTarget: "esp32s3",
      targetSnapshot: {
        model: "ESP32-S3",
        family: "ESP32-S3",
        evidence: "test",
      },
      inputFingerprint: "fixture",
    },
    process: {
      status: "succeeded",
      exitCode: 0,
      commands: [],
      startedAt: "2026-07-29T00:00:00.000Z",
      finishedAt: "2026-07-29T00:00:01.000Z",
      durationMs: 1_000,
      diagnostics: [],
      stdoutTail: "",
      stderrTail: "",
    },
    artifacts: [],
    download: { eligible: false, blockers: [] },
  }
}
