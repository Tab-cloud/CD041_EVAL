#!/usr/bin/env node
// 同步 eval-server 二进制到 tauri exe 旁
// 用法: node scripts/sync-server.mjs [profile]
//   profile = debug (默认) | release
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const SRC_BIN = process.platform === "win32" ? "eval-server.exe" : "eval-server"
const src = join(ROOT, "eval-server", SRC_BIN)
const canvasRuntime = process.platform === "win32" ? join(ROOT, "eval-server", "icudtl.dat") : null
if (!existsSync(src)) {
  console.error(`源文件不存在: ${src}\n请先运行 pnpm prepare:server`)
  process.exit(1)
}

const profile = process.argv[2] ?? "debug"
const targets = [
  // 打包模式: 生成的安装包/可执行目录（build 之后才有，先静默忽略失败）
  join(ROOT, "app/src-tauri/target", profile, "bundle/msi/Eval/eval-server.exe"),
  join(ROOT, "app/src-tauri/target", profile, "bundle/nsis/Eval/eval-server.exe"),
]

// 主目标: src-tauri/target/<profile>/eval-server.exe
//   — cargo run 时 cwd 在这里；Release 打包时 installer 也会把同级文件打进去
const dst = join(ROOT, "app/src-tauri/target", profile, SRC_BIN)
mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`已同步: ${src} -> ${dst}`)
if (canvasRuntime && existsSync(canvasRuntime)) {
  const runtimeTarget = join(dirname(dst), "icudtl.dat")
  copyFileSync(canvasRuntime, runtimeTarget)
  console.log(`已同步: ${canvasRuntime} -> ${runtimeTarget}`)
}

let copied = 1
for (const t of targets) {
  try {
    mkdirSync(dirname(t), { recursive: true })
    copyFileSync(src, t)
    console.log(`已同步: ${src} -> ${t}`)
    if (canvasRuntime && existsSync(canvasRuntime)) {
      const runtimeTarget = join(dirname(t), "icudtl.dat")
      copyFileSync(canvasRuntime, runtimeTarget)
      console.log(`已同步: ${canvasRuntime} -> ${runtimeTarget}`)
    }
    copied++
  } catch {
    // ignore — bundle 目录在 build 后才有
  }
}
console.log(`\n合计: ${copied} 个目标`)
