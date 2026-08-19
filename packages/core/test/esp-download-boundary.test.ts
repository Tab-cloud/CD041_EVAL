import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleProgrammerRoute } from "../src/runtime/server-programmer"
import { determineDownloadEligibility } from "../src/tool/hardware/build-manifest"
import type { BuildRequest } from "../src/tool/hardware/build-types"
import { ESP_ONLY_BUILD_MESSAGE } from "../src/runtime/esp-build-scope"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("ESP-only download boundary", () => {
  test("rejects non-ESP projects before discovering tools or hardware", async () => {
    const root = nonEspProject()
    const response = await handleProgrammerRoute(
      new Request(`http://localhost/api/programmer/status?projectDir=${encodeURIComponent(root)}&ports=1`),
      new URL(`http://localhost/api/programmer/status?projectDir=${encodeURIComponent(root)}&ports=1`),
      {},
    )
    expect(response?.status).toBe(409)
    expect(await response?.json()).toEqual({ error: ESP_ONLY_BUILD_MESSAGE })
  })

  test("does not expose the removed J-Link installer route", async () => {
    const response = await handleProgrammerRoute(
      new Request("http://localhost/api/programmer/install-jlink", {
        method: "POST",
        body: JSON.stringify({ confirmed: true, acceptedTerms: true }),
      }),
      new URL("http://localhost/api/programmer/install-jlink"),
      {},
    )
    expect(response).toBeNull()
  })

  test("cannot revive non-ESP flashing with a port or legacy firmware path", async () => {
    const root = nonEspProject()
    const response = await handleProgrammerRoute(
      new Request("http://localhost/api/programmer/flash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectDir: root,
          port: "COM7",
          firmwarePath: "build/legacy.hex",
          confirmed: true,
          verify: true,
        }),
      }),
      new URL("http://localhost/api/programmer/flash"),
      {},
    )
    expect(response?.status).toBe(409)
    expect((await response?.json() as { error: string }).error).toBe(ESP_ONLY_BUILD_MESSAGE)
  })

  test("download eligibility has no J-Link or arbitrary HEX fallback", () => {
    const request: BuildRequest = {
      schemaVersion: 1,
      requestId: "legacy-build",
      createdAt: new Date().toISOString(),
      projectDir: "project",
      projectRoot: "project",
      projectName: "legacy",
      buildDir: "build",
      buildSystem: "makefile",
      buildSystemSource: "project-config",
      mode: "incremental",
      target: "all",
      jobs: 1,
      timeoutMs: 60_000,
      toolchain: "arm-none-eabi-",
      targetSnapshot: { model: "STM32F103C8T6", family: "STM32F1", evidence: "test" },
      inputFingerprint: "legacy",
    }
    const result = determineDownloadEligibility(request, [{
      path: "legacy.hex",
      relativePath: "legacy.hex",
      format: "hex",
      freshness: "produced",
      valid: true,
      fileBytes: 16,
      sha256: "a".repeat(64),
      diagnostics: [],
    }])
    expect(result).toEqual({
      eligible: false,
      blockers: ["Eval 内置固件下载仅支持 ESP-IDF 工程；其他芯片请使用厂商工具手动下载"],
    })
  })
})

function nonEspProject(): string {
  const root = mkdtempSync(join(tmpdir(), "eval-download-boundary-"))
  roots.push(root)
  mkdirSync(join(root, ".eval"), { recursive: true })
  writeFileSync(join(root, ".eval", "project.toml"), [
    "[project]",
    'name = "non-esp"',
    'chip = "STM32F103C8T6"',
    'chip_family = "STM32F1"',
    "target_confirmed = true",
    'target_evidence = "test"',
    "",
    "[build]",
    'build_system = "makefile"',
    "timeout_seconds = 60",
    "",
    "[debug]",
    'programmer = ""',
    'target_cfg = ""',
  ].join("\n"))
  writeFileSync(join(root, "Makefile"), "all:\n\t@echo no\n")
  return root
}
