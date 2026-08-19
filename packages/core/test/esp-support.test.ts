import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBuildPlan } from "../src/tool/hardware/build-backends"
import { buildConfigFromContext, createBuildRequest } from "../src/runtime/build-context"
import { evaluateBuildTargetGuard } from "../src/runtime/build-target-guard"
import { buildManifest, resolveProgrammingBundle, saveBuildManifest } from "../src/tool/hardware/build-manifest"
import type { BuildArtifactOutcome, BuildProcessOutcome, BuildRequest } from "../src/tool/hardware/build-types"
import {
  assertEspChipMatch,
  buildEspFlashCommands,
  classifyEspTransport,
  loadCertifiedEspBundle,
  parseDetectedEspChip,
} from "../src/tool/hardware/esptool-service"
import { projectInitTool } from "../src/tool/hardware/project-init"
import { compileTool } from "../src/tool/hardware/compile"
import { chipAddTool } from "../src/tool/hardware/chip-add"
import { resolveEspBuildTarget } from "../src/runtime/esp-build-scope"
import { loadProjectConfig } from "../src/store/project-config"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("ESP platform support", () => {
  test("generates a native ESP-IDF project without ARM startup or linker files", async () => {
    const root = temporaryRoot()
    const result = await projectInitTool.execute({
      projectName: "esp_demo",
      chipModel: "ESP32-S3",
      outputDir: ".",
      rtos: "none",
    }, {
      sessionId: "test",
      agentId: "project-initializer",
      workingDir: root,
      scope: "full-access",
    })
    expect(result.success).toBe(true)
    const project = join(root, "esp_demo")
    expect(readFileSync(join(project, "CMakeLists.txt"), "utf8")).toContain("IDF_PATH")
    expect(readFileSync(join(project, "main", "CMakeLists.txt"), "utf8")).toContain("idf_component_register")
    expect(existsSync(join(project, "src", "startup.c"))).toBe(false)
    expect(existsSync(join(project, "esp32-s3.ld"))).toBe(false)
    const config = loadProjectConfig(project)
    expect(config.build).toMatchObject({
      build_system: "idf",
      platform_target: "esp32s3",
    })
    expect(config.debug.programmer).toBe("esptool")
    const build = buildConfigFromContext(project)
    expect(evaluateBuildTargetGuard(project, build)).toBeUndefined()
    expect(createBuildRequest(build)).toMatchObject({
      buildSystem: "idf",
      platformTarget: "esp32s3",
      targetSnapshot: { model: "ESP32-S3" },
    })
  })

  test("keeps non-ESP source design available while rejecting built-in compilation", async () => {
    const root = temporaryRoot()
    const result = await projectInitTool.execute({
      projectName: "stm_design",
      chipModel: "STM32F103C8T6",
      outputDir: ".",
      rtos: "none",
    }, {
      sessionId: "test",
      agentId: "project-initializer",
      workingDir: root,
      scope: "full-access",
    })
    expect(result.success).toBe(true)
    const project = join(root, "stm_design")
    expect(existsSync(join(project, "src", "main.c"))).toBe(true)
    const compile = await compileTool.execute({ projectDir: "." }, {
      sessionId: "non-esp-design",
      agentId: "main-agent",
      workingDir: project,
    })
    expect(compile.success).toBe(false)
    expect(compile.outcome?.diagnostic?.kind).toBe("unsupported-build-platform")
    expect(compile.outcome?.diagnostic?.nextActions.join("\n")).toContain("源码编写")
    expect(compile.outcome?.diagnostic?.nextActions.join("\n")).toContain("手动编译")
  })

  test("extends ESP compile support through platform metadata instead of model hardcoding", async () => {
    const root = temporaryRoot()
    const result = await chipAddTool.execute({
      model: "ESP32-H2-CUSTOM",
      family: "ESP32-H2",
      manufacturer: "Espressif",
      core: "RISC-V 32",
      platformTarget: "esp32h2",
      scope: "project",
    }, {
      sessionId: "test",
      agentId: "main-agent",
      workingDir: root,
      scope: "full-access",
    })
    expect(result.success).toBe(true)
    expect(resolveEspBuildTarget("ESP32-H2-CUSTOM", root).buildTarget).toBe("esp32h2")

    const nonEsp = await chipAddTool.execute({
      model: "VENDOR-CUSTOM",
      manufacturer: "OtherVendor",
      platformTarget: "esp32h2",
      scope: "project",
    }, {
      sessionId: "test",
      agentId: "main-agent",
      workingDir: root,
      scope: "full-access",
    })
    expect(nonEsp.success).toBe(false)
  })

  test("configures the ESP-IDF target before the first build", () => {
    const root = temporaryRoot()
    const request = buildRequest(root)
    expect(createBuildPlan(request).steps.map((item) => item.command)).toEqual([
      ["idf.py", "-B", request.buildDir, "set-target", "esp32s3"],
      ["idf.py", "-B", request.buildDir, "build"],
    ])
  })

  test("certifies every ESP-IDF BIN using flasher_args addresses and hashes", () => {
    const root = temporaryRoot()
    const request = buildRequest(root)
    mkdirSync(join(root, "build", "bootloader"), { recursive: true })
    mkdirSync(join(root, "build", "partition_table"), { recursive: true })
    const files = [
      ["bootloader/bootloader.bin", Buffer.alloc(1024, 1)],
      ["partition_table/partition-table.bin", Buffer.alloc(4096, 2)],
      ["esp_demo.bin", Buffer.alloc(8192, 3)],
    ] as const
    const artifacts: BuildArtifactOutcome[] = files.map(([name, contents]) => {
      const path = join(root, "build", name)
      writeFileSync(path, contents)
      return {
        path,
        relativePath: join("build", name),
        format: "bin",
        freshness: "produced",
        valid: true,
        fileBytes: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        diagnostics: [],
      }
    })
    writeFileSync(join(root, "build", "flasher_args.json"), JSON.stringify({
      flash_files: {
        "0x0": "bootloader/bootloader.bin",
        "0x8000": "partition_table/partition-table.bin",
        "0x10000": "esp_demo.bin",
      },
      flash_settings: { flash_mode: "dio", flash_freq: "80m", flash_size: "8MB" },
      extra_esptool_args: { chip: "esp32s3" },
    }))
    const bundle = resolveProgrammingBundle(request, artifacts)
    expect(bundle?.images.map((item) => item.offset)).toEqual([0, 0x8000, 0x10000])
    expect(bundle?.flashSettings.flashMode).toBe("dio")
    const manifest = buildManifest(request, successfulProcess(), artifacts)
    expect(manifest.download).toMatchObject({ eligible: true, provider: "esptool", bundleId: bundle?.bundleId })
    saveBuildManifest(manifest)
    expect(loadCertifiedEspBundle(root)?.bundleId).toBe(bundle?.bundleId)

    writeFileSync(join(root, "build", "esp_demo.bin"), Buffer.alloc(8192, 4))
    expect(loadCertifiedEspBundle(root)).toBeNull()
  })

  test("classifies native USB and USB-UART download transports", () => {
    expect(classifyEspTransport("UsbPort(ESP32-S3 USB Serial/JTAG)")).toBe("usb-native")
    expect(classifyEspTransport("UsbPort(CH343 USB-SERIAL)")).toBe("usb-uart")
    expect(classifyEspTransport("Bluetooth serial port")).toBe("uart")
  })

  test("builds write and mandatory verify commands for every certified image", () => {
    const commands = buildEspFlashCommands({
      command: ["python", "-m", "esptool"],
      displayCommand: "python -m esptool",
      version: "5.0",
    }, {
      bundleId: "bundle",
      provider: "esptool",
      chip: "esp32s3",
      images: [
        { path: "bootloader.bin", relativePath: "build/bootloader.bin", offset: 0, fileBytes: 1, sha256: "a" },
        { path: "app.bin", relativePath: "build/app.bin", offset: 0x10000, fileBytes: 1, sha256: "b" },
      ],
      flashSettings: { flashMode: "dio", flashFreq: "80m", flashSize: "8MB" },
    }, "COM7", 460800)
    expect(commands.write).toEqual([
      "python", "-m", "esptool", "--chip", "esp32s3", "--port", "COM7", "--baud", "460800",
      "--before", "default-reset", "--after", "hard-reset", "write-flash",
      "--flash-mode", "dio", "--flash-freq", "80m", "--flash-size", "8MB",
      "0x0", "bootloader.bin", "0x10000", "app.bin",
    ])
    expect(commands.verify).toContain("verify-flash")
    expect(commands.verify).not.toContain("write-flash")
  })

  test("rejects a physically connected ESP chip that differs from the project target", () => {
    expect(parseDetectedEspChip("Chip is ESP32-S3 (revision v0.2)")).toBe("esp32s3")
    expect(() => assertEspChipMatch("esp32c3", "esp32s3")).toThrow("不一致")
  })

  test("rejects overlapping or escaping ESP-IDF image declarations", () => {
    const root = temporaryRoot()
    const request = buildRequest(root)
    mkdirSync(join(root, "build"), { recursive: true })
    const path = join(root, "build", "one.bin")
    writeFileSync(path, Buffer.alloc(0x2000, 1))
    const artifact: BuildArtifactOutcome = {
      path,
      relativePath: "build/one.bin",
      format: "bin",
      freshness: "produced",
      valid: true,
      fileBytes: 0x2000,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      diagnostics: [],
    }
    writeFileSync(join(root, "build", "flasher_args.json"), JSON.stringify({
      flash_files: { "0x1000": "one.bin", "0x1800": "one.bin" },
      extra_esptool_args: { chip: "esp32s3" },
    }))
    expect(resolveProgrammingBundle(request, [artifact])).toBeUndefined()
    writeFileSync(join(root, "build", "flasher_args.json"), JSON.stringify({
      flash_files: { "0x1000": "../outside.bin" },
      extra_esptool_args: { chip: "esp32s3" },
    }))
    expect(resolveProgrammingBundle(request, [artifact])).toBeUndefined()
  })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "eval-esp-"))
  roots.push(root)
  return root
}

function buildRequest(root: string): BuildRequest {
  return {
    schemaVersion: 1,
    requestId: "esp-build",
    createdAt: new Date().toISOString(),
    projectDir: root,
    projectRoot: root,
    projectName: "esp_demo",
    buildDir: join(root, "build"),
    buildSystem: "idf",
    buildSystemSource: "project-config",
    mode: "incremental",
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
    inputFingerprint: "fingerprint",
  }
}

function successfulProcess(): BuildProcessOutcome {
  return {
    status: "succeeded",
    exitCode: 0,
    commands: [{ phase: "build", command: ["idf.py", "build"] }],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    diagnostics: [],
    stdoutTail: "",
    stderrTail: "",
  }
}
