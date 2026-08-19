import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import {
  authorizeShellProcess,
  inspectShellCommand,
} from "../src/runtime/process-capability-broker.ts"
import { bashTool } from "../src/tool/general/bash.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (root.startsWith(tmpdir()) && existsSync(root)) rmSync(root, { recursive: true, force: true })
  }
})

describe("process capability broker", () => {
  test("compiler and build drivers cannot execute through generic shell", () => {
    const cwd = process.cwd()
    const commands = [
      "make -C firmware all",
      "cmd /c make -C firmware all",
      "powershell -Command \"make -C firmware all\"",
      "sh -c 'make -C firmware all'",
      "idf.py -B build build",
      "arm-none-eabi-gcc -c main.c",
    ]
    for (const command of commands) {
      const decision = authorizeShellProcess(command, cwd)
      expect(decision.allowed).toBe(false)
      expect(decision.findings.some((finding) => finding.capability === "embedded-build")).toBe(true)
    }
  })

  test("managed project type does not revoke policy-authorized terminal processes", () => {
    const root = managedProject()
    for (const command of [
      "pnpm run build",
      "python build.py",
      "node tools/build.mjs",
      "firmware-build.cmd",
      "unknown-builder --target device",
    ]) {
      const decision = authorizeShellProcess(command, root)
      expect(decision.allowed).toBe(true)
      expect(decision.projectRoot).toBe(root)
    }
    expect(authorizeShellProcess("rg -n target .", root).allowed).toBe(true)
    expect(authorizeShellProcess("git status --short", root).allowed).toBe(true)
  })

  test("opaque host processes remain available outside managed hardware projects", () => {
    const root = join(tmpdir(), `eval-host-project-${randomUUID()}`)
    mkdirSync(root)
    roots.push(root)
    expect(authorizeShellProcess("pnpm test", root).allowed).toBe(true)
    expect(authorizeShellProcess("node scripts/check.mjs", root).allowed).toBe(true)
  })

  test("an authorized PowerShell script executes inside a managed project", async () => {
    if (process.platform !== "win32") return
    const root = managedProject()
    const tools = join(root, "tools")
    const marker = join(root, "render-complete.txt")
    mkdirSync(tools)
    writeFileSync(join(tools, "render.ps1"), [
      "$ErrorActionPreference = 'Stop'",
      "Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\\render-complete.txt') -Value 'ok' -Encoding UTF8",
    ].join("\n"), "utf8")

    const result = await bashTool.execute({ command: ".\\tools\\render.ps1" }, {
      sessionId: "managed-script",
      agentId: "main-agent",
      workingDir: root,
    })

    expect(result.success).toBe(true)
    expect(existsSync(marker)).toBe(true)
  })

  test("network and hardware executables retain distinct runtime capabilities", () => {
    const root = join(tmpdir(), `eval-host-project-${randomUUID()}`)
    mkdirSync(root)
    roots.push(root)

    expect(inspectShellCommand("curl https://example.com", root)[0]?.capability).toBe("network")
    expect(inspectShellCommand("openocd -f board.cfg", root)[0]?.capability).toBe("hardware")
    expect(authorizeShellProcess("curl https://example.com", root).allowed).toBe(true)
    expect(authorizeShellProcess("openocd -f board.cfg", root).allowed).toBe(false)
  })

  test("nested encoded shells fail closed before any process starts", async () => {
    const root = managedProject()
    const marker = join(root, "should-not-exist.txt")
    const decision = inspectShellCommand(
      `powershell -EncodedCommand ZQBjAGgAbwAgAGIAeQBwAGEAcwBzAA==`,
      root,
    )
    expect(decision[0]?.capability).toBe("opaque-process")
    const result = await bashTool.execute({
      command: `cmd /c echo bypass>${marker}`,
    }, {
      sessionId: "process-boundary",
      agentId: "main-agent",
      workingDir: root,
    })
    expect(result.success).toBe(false)
    expect((result.data as { status?: string }).status).toBe("process-capability-denied")
    expect(existsSync(marker)).toBe(false)
  })
})

function managedProject(): string {
  const root = join(tmpdir(), `eval-managed-project-${randomUUID()}`)
  mkdirSync(join(root, ".eval"), { recursive: true })
  writeFileSync(join(root, ".eval", "project.toml"), [
    "[project]",
    'name = "fixture"',
    'chip = "STM32F103C8T6"',
    'chip_family = "STM32F1"',
    "target_confirmed = true",
    "",
    "[build]",
    'build_system = "makefile"',
    "",
  ].join("\n"))
  roots.push(root)
  return root
}
