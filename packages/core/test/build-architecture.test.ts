import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildConfigFromContext,
  createBuildRequest,
} from "../src/runtime/build-context"
import { createBuildPlan } from "../src/tool/hardware/build-backends"
import {
  resolveBuildArtifacts,
  saveBuildManifest,
  snapshotBuildArtifacts,
} from "../src/tool/hardware/build-manifest"
import type { BuildRequest, BuildRunManifest } from "../src/tool/hardware/build-types"
import { runProcess } from "../src/tool/process"
import { compileTool } from "../src/tool/hardware/compile"
import { deriveToolExecutionSemantics } from "../src/runtime/tool-execution-semantics"
import { BuildLogRepo } from "../src/store/build-log"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("build architecture", () => {
  test("ESP project configuration is authoritative and build plans use only idf.py", () => {
    const root = projectRoot("idf")
    const config = buildConfigFromContext(root, { target: "firmware", jobs: 8 })
    const request = createBuildRequest(config)
    const command = createBuildPlan(request).steps.at(-1)!.command
    expect(config.buildSystem).toBe("idf")
    expect(config.buildSystemSource).toBe("project-config")
    expect(command).toEqual(["idf.py", "-B", join(root, "build"), "firmware"])
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.targetSnapshot)).toBe(true)
  })

  test("build input fingerprint changes with source content", () => {
    const root = projectRoot("idf")
    writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n")
    const first = createBuildRequest(buildConfigFromContext(root))
    writeFileSync(join(root, "main.c"), "int main(void) { return 1; }\n")
    const second = createBuildRequest(buildConfigFromContext(root))
    expect(first.inputFingerprint).not.toBe(second.inputFingerprint)
  })

  test("artifact resolution rejects stale files and only reuses a certified matching fingerprint", async () => {
    const root = projectRoot("idf")
    const buildDir = join(root, "build")
    mkdirSync(buildDir, { recursive: true })
    const hex = join(buildDir, "firmware.hex")
    writeFileSync(hex, validHex())
    const request = createBuildRequest(buildConfigFromContext(root))
    const before = snapshotBuildArtifacts(buildDir)
    expect(await resolveBuildArtifacts(request, before)).toEqual([])

    const parsed = await resolveBuildArtifacts(request, new Map())
    expect(parsed).toHaveLength(1)
    const manifest = successfulManifest(request, parsed)
    saveBuildManifest(manifest)

    const next = { ...request, requestId: "next-request" }
    expect((await resolveBuildArtifacts(next, snapshotBuildArtifacts(buildDir)))[0]?.freshness)
      .toBe("verified-reuse")
    const unrelated = { ...next, requestId: "unrelated", inputFingerprint: "different" }
    expect(await resolveBuildArtifacts(unrelated, snapshotBuildArtifacts(buildDir))).toEqual([])
  })

  test("compile verification is targeted to the project instead of global", () => {
    const semantics = deriveToolExecutionSemantics(compileTool, { projectDir: "Code/V1.0" }, {
      success: true,
      outcome: { status: "succeeded", category: "build", summary: "ok" },
    })
    expect(semantics.verification).toBe(true)
    expect(semantics.verificationTargets).toEqual(["code/v1.0"])
    expect(semantics.globalVerification).toBe(false)
  })

  test("process output preserves stderr identity", async () => {
    const seen: Array<{ line: string; type: string }> = []
    const result = await runProcess([process.execPath, "-e", "console.error('typed-error')"], {
      timeoutMs: 10_000,
      onLine: (line, type) => seen.push({ line, type }),
    })
    expect(result.exitCode).toBe(0)
    expect(seen).toContainEqual({ line: "typed-error", type: "stderr" })
  })

  test("cancellation terminates the complete process tree", async () => {
    const root = projectRoot("makefile")
    writeFileSync(join(root, "Makefile"), "all:\n\t@echo ok\n")
    const marker = join(root, "orphan-marker.txt")
    const childScript = `setTimeout(() => Bun.write(${JSON.stringify(marker)}, "orphan"), 700)`
    const parentScript = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(childScript)}]); setInterval(() => {}, 1000)`
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 100)
    const result = await runProcess([process.execPath, "-e", parentScript], {
      signal: abort.signal,
      timeoutMs: 5_000,
    })
    expect(result.aborted).toBe(true)
    await Bun.sleep(900)
    expect(existsSync(marker)).toBe(false)
  })

  test("a confirmed non-ESP Make project is rejected before process execution", async () => {
    const root = projectRoot("makefile")
    writeFileSync(join(root, "Makefile"), "all:\n\t@echo must-not-run\n")
    expect(() => createBuildRequest(buildConfigFromContext(root))).toThrow("仅支持 Espressif")
    const result = await compileTool.execute({ projectDir: "." }, {
      sessionId: "non-esp", agentId: "main-agent", workingDir: root,
    })
    expect(result.success).toBe(false)
    expect(result.outcome?.diagnostic?.kind).toBe("unsupported-build-platform")
    expect(result.outcome?.diagnostic?.nextActions.join("\n")).toContain("源码编写")
  })

  test("build logs use a dedicated durable store", () => {
    const sessionId = `build-log-${Date.now()}-${Math.random()}`
    BuildLogRepo.append("run-a", sessionId, 11, { type: "stdout", text: "CC main.c" }, 10)
    BuildLogRepo.append("run-a", sessionId, 12, { type: "stderr", text: "warning" }, 20)
    expect(BuildLogRepo.listBySession(sessionId)).toEqual([
      {
        runId: "run-a",
        sessionId,
        seq: 11,
        type: "tool-stream",
        payload: { target: "build", type: "stdout", text: "CC main.c" },
        projectionVersion: 0,
        createdAt: 10,
      },
      {
        runId: "run-a",
        sessionId,
        seq: 12,
        type: "tool-stream",
        payload: { target: "build", type: "stderr", text: "warning" },
        projectionVersion: 0,
        createdAt: 20,
      },
    ])
    BuildLogRepo.deleteBySession(sessionId)
    expect(BuildLogRepo.listBySession(sessionId)).toEqual([])
  })
})

function projectRoot(buildSystem: "makefile" | "cmake" | "idf"): string {
  const root = mkdtempSync(join(tmpdir(), "eval-build-architecture-"))
  roots.push(root)
  mkdirSync(join(root, ".eval"), { recursive: true })
  const esp = buildSystem === "idf"
  writeFileSync(join(root, ".eval", "project.toml"), [
    "[project]",
    'name = "firmware"',
    `chip = "${esp ? "ESP32-S3" : "STM32F103C8T6"}"`,
    `chip_family = "${esp ? "ESP32-S3" : "STM32F1"}"`,
    "target_confirmed = true",
    'target_evidence = "unit test"',
    "",
    "[build]",
    `toolchain = "${esp ? "" : "arm-none-eabi-"}"`,
    `build_system = "${buildSystem}"`,
    ...(esp ? ['platform_target = "esp32s3"'] : []),
    "timeout_seconds = 60",
    "",
    "[debug]",
    `programmer = "${esp ? "esptool" : ""}"`,
    'target_cfg = ""',
  ].join("\n"))
  if (esp) {
    writeFileSync(join(root, "CMakeLists.txt"), [
      "cmake_minimum_required(VERSION 3.16)",
      'include($ENV{IDF_PATH}/tools/cmake/project.cmake)',
      "project(firmware)",
      "",
    ].join("\n"))
  }
  return root
}

function validHex(): string {
  return ":020000040800F2\n:0400100001020304E2\n:00000001FF\n"
}

function successfulManifest(
  request: BuildRequest,
  artifacts: BuildRunManifest["artifacts"],
): BuildRunManifest {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    request,
    process: {
      status: "succeeded",
      exitCode: 0,
      commands: [{ phase: "build", command: ["make"] }],
      startedAt: now,
      finishedAt: now,
      durationMs: 1,
      diagnostics: [],
      stdoutTail: "",
      stderrTail: "",
    },
    artifacts,
    download: { eligible: false, blockers: ["no profile"] },
  }
}
