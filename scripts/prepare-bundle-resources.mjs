#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = join(scriptDirectory, "..")
const destination = join(root, "bundle-resources")
const windows = process.platform === "win32"
const serverName = windows ? "eval-server.exe" : "eval-server"
const serialName = windows ? "eval-serial.exe" : "eval-serial"

mkdirSync(destination, { recursive: true })
for (const name of ["eval-server", "eval-server.exe", "eval-serial", "eval-serial.exe", "icudtl.dat"]) {
  const stalePath = join(destination, name)
  if (existsSync(stalePath)) unlinkSync(stalePath)
}

const resources = [
  [join(root, "eval-server", serverName), serverName],
  [join(root, "tools/eval-serial/target/release", serialName), serialName],
]
if (windows) resources.push([join(root, "eval-server/icudtl.dat"), "icudtl.dat"])

for (const [source, name] of resources) {
  if (!existsSync(source)) throw new Error(`Bundle resource is missing: ${source}`)
  copyFileSync(source, join(destination, name))
}

console.log(`Prepared ${resources.length} bundle resources for ${process.platform}-${process.arch}`)
