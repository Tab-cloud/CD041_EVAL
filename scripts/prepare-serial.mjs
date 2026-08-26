#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = join(scriptDirectory, "..")
const manifestPath = join(root, "tools/eval-serial/Cargo.toml")
const targetDirectory = join(root, "tools/eval-serial/target")

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!process.argv.includes("--macos-universal") || process.platform !== "darwin") {
  throw new Error("This script only builds the Universal macOS serial sidecar")
}

const arm64Target = "aarch64-apple-darwin"
const x64Target = "x86_64-apple-darwin"
for (const target of [arm64Target, x64Target]) {
  run("cargo", ["build", "--release", "--manifest-path", manifestPath, "--target", target])
}

const outputPath = join(targetDirectory, "release/eval-serial")
mkdirSync(dirname(outputPath), { recursive: true })
run("lipo", [
  "-create",
  "-output",
  outputPath,
  join(targetDirectory, arm64Target, "release/eval-serial"),
  join(targetDirectory, x64Target, "release/eval-serial"),
])
