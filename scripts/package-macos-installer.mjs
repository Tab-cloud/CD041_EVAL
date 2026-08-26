#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = join(scriptDirectory, "..")
const version = JSON.parse(readFileSync(join(root, "app/package.json"), "utf8")).version
const appPath = join(root, "app/src-tauri/target/universal-apple-darwin/release/bundle/macos/Eval.app")
const outputDirectory = join(root, "dist", version)
const outputPath = join(outputDirectory, `Eval_${version}_universal.pkg`)

if (process.platform !== "darwin") throw new Error("macOS installer packaging requires macOS")
if (!existsSync(appPath)) throw new Error(`Universal app is missing: ${appPath}`)

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

mkdirSync(outputDirectory, { recursive: true })
if (existsSync(outputPath)) unlinkSync(outputPath)

const temporaryDirectory = mkdtempSync(join(tmpdir(), "eval-installer-"))
const packageRoot = join(temporaryDirectory, "root")
const applicationsDirectory = join(packageRoot, "Applications")
const componentPlist = join(temporaryDirectory, "components.plist")
const componentPackage = join(temporaryDirectory, "Eval-component.pkg")
const distributionPath = join(temporaryDirectory, "Distribution.xml")

try {
  mkdirSync(applicationsDirectory, { recursive: true })
  run("ditto", [appPath, join(applicationsDirectory, "Eval.app")])
  run("pkgbuild", ["--analyze", "--root", packageRoot, componentPlist])
  run("plutil", ["-replace", "0.BundleIsRelocatable", "-bool", "NO", componentPlist])
  run("pkgbuild", [
    "--root",
    packageRoot,
    "--component-plist",
    componentPlist,
    "--identifier",
    "com.evalagent.desktop.pkg",
    "--version",
    version,
    componentPackage,
  ])
  run("productbuild", ["--synthesize", "--package", componentPackage, distributionPath])

  const distribution = readFileSync(distributionPath, "utf8").replace(
    /(<installer-gui-script[^>]*>)/,
    `$1\n    <title>Eval ${version}</title>`,
  )
  writeFileSync(distributionPath, distribution, "utf8")
  run("productbuild", [
    "--distribution",
    distributionPath,
    "--package-path",
    temporaryDirectory,
    outputPath,
  ])
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}

console.log(`macOS Installer package created: ${outputPath}`)
