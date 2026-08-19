/**
 * Tool helpers — 超时 / 前置检查 / 路径消毒
 */
import { resolve, relative, isAbsolute, sep } from "node:path"
import { existsSync, realpathSync } from "node:fs"
import { randomUUID } from "node:crypto"

/** 为异步操作添加超时 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = "操作"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 检查命令行工具是否可用 */
export async function checkTool(name: string): Promise<boolean> {
  try {
    const which = process.platform === "win32" ? "where" : "which"
    const proc = Bun.spawn([which, name], { stdout: "pipe", stderr: "pipe" })
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}

/**
 * 消毒路径，防止目录穿越。返回收容到 baseDir 内的绝对路径。
 * 越权（逃逸到 baseDir 之外或跨盘符）时抛错。
 *
 * 注意：用 relative + 前缀碰撞安全的判断，避免 `startsWith(base)`
 * 把 `/proj/app-evil` 误判为 `/proj/app` 的子路径。
 */
export function safePath(baseDir: string, userPath: string): string {
  const base = resolve(baseDir)
  const resolved = resolve(base, userPath)
  assertInside(base, resolved, userPath)

  const realBase = realpathSync.native(base)
  let existing = resolved
  while (!existsSync(existing)) {
    const parent = resolve(existing, "..")
    if (parent === existing) break
    existing = parent
  }
  const realExisting = realpathSync.native(existing)
  assertInside(realBase, realExisting, userPath)
  return resolved
}

function assertInside(base: string, target: string, label: string): void {
  const rel = relative(base, target)
  // rel === "" 表示 resolved === base（允许）；以 ".." 开头表示逃逸；
  // isAbsolute(rel) 处理 Windows 跨盘符（relative 返回绝对路径）的情况。
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`路径越权: ${label}`)
  }
}

/** 判断 target 解析后是否在 baseDir 内（含 baseDir 自身），不抛错。 */
export function isPathInside(baseDir: string, target: string): boolean {
  const base = resolve(baseDir)
  const resolved = resolve(base, target)
  const rel = relative(base, resolved)
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
}

/** 生成工具调用 ID */
export function generateId(prefix = "tc"): string {
  return `${prefix}-${randomUUID()}`
}
