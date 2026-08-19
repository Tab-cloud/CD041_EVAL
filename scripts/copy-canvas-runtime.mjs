#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = join(scriptDirectory, "..")

// @napi-rs/canvas on Windows requires Skia's ICU data beside the executable.
// Bun embeds the native addon in a standalone executable but not this data file.
if (process.platform === "win32" && process.arch === "x64") {
  const source = join(root, "node_modules", "@napi-rs", "canvas-win32-x64-msvc", "icudtl.dat")
  const destination = join(root, "eval-server", "icudtl.dat")
  if (!existsSync(source)) {
    throw new Error(`Canvas runtime file is missing: ${source}`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  console.log(`Canvas runtime copied: ${destination}`)
}
