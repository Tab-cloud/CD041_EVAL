#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = join(scriptDirectory, "..")
const executableName = process.platform === "win32" ? "eval-server.exe" : "eval-server"
const outputPath = join(root, "eval-server", executableName)
const entryPath = join(root, "packages/core/src/runtime/index.ts")

mkdirSync(dirname(outputPath), { recursive: true })

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.argv.includes("--macos-universal")) {
  if (process.platform !== "darwin") throw new Error("Universal macOS server builds require macOS")
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "eval-server-universal-"))
  const arm64Path = join(temporaryDirectory, "eval-server-arm64")
  const x64Path = join(temporaryDirectory, "eval-server-x64")
  try {
    run("bun", ["build", "--compile", "--target=bun-darwin-arm64", entryPath, `--outfile=${arm64Path}`])
    run("bun", ["build", "--compile", "--target=bun-darwin-x64-baseline", entryPath, `--outfile=${x64Path}`])
    run("lipo", ["-create", "-output", outputPath, arm64Path, x64Path])
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
} else {
  run("bun", ["build", "--compile", entryPath, `--outfile=${outputPath}`])
}
