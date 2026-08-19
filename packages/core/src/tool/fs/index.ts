/**
 * 基础文件系统工具：read / write / edit / glob / grep
 * 所有操作限定在 workingDir 内，防止越权访问
 */
import { defineTool } from "../define"
import { safePath } from "../helpers"
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { lstat as lstatAsync, readFile as readFileAsync, readdir as readdirAsync, stat as statAsync } from "node:fs/promises"
import { resolve, join, relative, dirname } from "node:path"
import { documentIngestionPipeline, isPdfDocument } from "../../util/document-ingestion.ts"
import { isOfficeDocument } from "../../util/office.ts"

// ── read ──
export const readTool = defineTool({
  name: "read",
  description: "读取一个或多个文件。支持文本、可提取文本的 PDF 及 DOC/DOCX/XLSX/PPTX；图形型 PDF 会返回类型感知的专用工具指引。",
  parameters: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "要读取的文件路径列表（相对于工作目录）" },
    },
    required: ["paths"],
  },
  async execute({ paths }: { paths: string[] }, ctx) {
    const results: Record<string, string> = {}
    let failures = 0
    const missingPaths: string[] = []
    let otherFailures = 0
    for (const p of (Array.isArray(paths) ? paths : [paths])) {
      try {
        const abs = safePath(ctx.workingDir, p)
        if (!existsSync(abs)) {
          results[p] = `[路径不存在]`
          failures++
          missingPaths.push(p)
          continue
        }
        const st = statSync(abs)
        if (st.isDirectory()) {
          const items = readdirSync(abs)
          // 目录：显示文件/夹列表，标注类型和大小
          const lines: string[] = []
          for (const name of items) {
            try {
              const childPath = join(abs, name)
              const cs = statSync(childPath)
              const type = cs.isDirectory() ? "/" : ""
              const size = cs.isFile() ? ` (${cs.size < 1024 ? cs.size + "B" : (cs.size / 1024).toFixed(0) + "KB"})` : ""
              lines.push(`  ${name}${type}${size}`)
            } catch { lines.push(`  ${name}`) }
          }
          const truncated = items.length > 50
          const display = truncated ? lines.slice(0, 50) : lines
          results[p] = `${truncated ? "[前50项] " : ""}${items.length} 项:\n${display.join("\n")}`
        } else if (isPdfDocument(p) || isOfficeDocument(p)) {
          if (st.size > 20 * 1024 * 1024) {
            results[p] = `[文档过大: ${(st.size / 1024 / 1024).toFixed(1)}MB，最大支持 20MB]`
            failures++
            otherFailures++
            continue
          }
          try {
            const document = await documentIngestionPipeline.ingest({
              name: p,
              bytes: new Uint8Array(readFileSync(abs)),
              maxChars: 200_000,
            })
            const pageLabel = document.pages > 0
              ? document.format === "XLSX" ? ` · ${document.pages} sheets` : ` · ${document.pages} 页`
              : ""
            const graphHint = document.format === "PDF" && document.graphical
              ? "\n\n[提示: 此 PDF 文本极少，图形布局未被普通 read 提取。原理图请使用 schematic_read，数据手册请使用 datasheet_read。]"
              : ""
            results[p] = `[${document.format}${pageLabel}${document.truncated ? " · 已截断" : ""}]${graphHint}\n\n${document.text}`
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            results[p] = `[文档解析失败: ${message}]`
            failures++
            otherFailures++
          }
        } else if (st.size > 200_000) {
          results[p] = `[文件过大: ${(st.size / 1024).toFixed(0)}KB，请指定更具体的路径]`
          failures++
          otherFailures++
        } else {
          results[p] = readFileSync(abs, "utf-8")
        }
      } catch (err: any) {
        results[p] = `[读取失败: ${err.message}]`
        failures++
        otherFailures++
      }
    }
    if (failures === 0) return { success: true, data: results }
    const error = `${failures} 个路径读取失败`
    if (missingPaths.length > 0 && otherFailures === 0) {
      return {
        success: false,
        data: results,
        error,
        outcome: {
          status: "failed" as const,
          category: "evidence" as const,
          summary: error,
          fingerprint: "read:path-not-found",
          diagnostic: {
            kind: "path-not-found",
            evidence: missingPaths.slice(0, 20).map((path) => `目标不存在: ${path}`),
            nextActions: ["把目标不存在视为当前工作区事实，按原目标选择创建目标、改用已有路径或继续其他工作"],
            retryable: true,
            failureDisposition: "continue" as const,
            missingPath: missingPaths[0],
          },
        },
      }
    }
    return { success: false, data: results, error }
  },
  contract: { effects: ["workspace-read"], idempotency: "read-only", cancellation: "unsupported", progress: { role: "inspection", targetParameters: ["paths"] } }, permission: "read",
})

// ── write ──
export const writeTool = defineTool({
  name: "write",
  description: "创建或覆盖写入文件。会自动创建父目录；如果目标已存在，必须先在当前执行中用 read 读取该文件的最新内容。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "写入路径（相对于工作目录）" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
  },
  async execute({ path, content }: { path: string; content: string }, ctx) {
    try {
      const abs = safePath(ctx.workingDir, path)
      mkdirSync(dirname(abs), { recursive: true })
      atomicWriteText(abs, content)
      return { success: true, data: { path, size: content.length } }
    } catch (err: any) { return { success: false, error: err.message } }
  },
  contract: { effects: ["workspace-write"], idempotency: "idempotent", cancellation: "unsupported", progress: { role: "mutation", targetParameters: ["path"] } }, permission: "write",
})

// ── edit ──
export const editTool = defineTool({
  name: "edit",
  description: "在文件中进行精确文本替换（查找并替换）。调用前必须先在当前执行中用 read 读取目标文件的最新内容。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（相对于工作目录）" },
      oldText: { type: "string", description: "要查找并替换的原文（必须是文件中唯一出现的一段）" },
      newText: { type: "string", description: "替换为的新文本" },
    },
    required: ["path", "oldText", "newText"],
  },
  async execute({ path, oldText, newText }: { path: string; oldText: string; newText: string }, ctx) {
    try {
      const abs = safePath(ctx.workingDir, path)
      if (!existsSync(abs)) return { success: false, error: `文件不存在: ${path}` }
      let content = readFileSync(abs, "utf-8")
      if (!content.includes(oldText)) {
        const summary = `目标文件中未找到要替换的精确文本: ${path}`
        return {
          success: false,
          error: summary,
          outcome: {
            status: "failed",
            category: "evidence",
            summary,
            fingerprint: `edit-target-mismatch:${path}`,
            diagnostic: {
              kind: "edit-target-mismatch",
              evidence: [`文件仍存在，但 oldText 与当前内容不一致: ${path}`],
              nextActions: [
                `重新调用 read 读取 ${path} 的当前内容`,
                "从最新内容复制足够且唯一的原文片段后再次调用 edit",
                "不得改用 write 整体覆盖现有文件",
              ],
            },
          },
        }
      }
      const count = content.split(oldText).length - 1
      if (count > 1) {
        const summary = `匹配到 ${count} 处，oldText 不唯一: ${path}`
        return {
          success: false,
          error: summary,
          outcome: {
            status: "failed",
            category: "evidence",
            summary,
            fingerprint: `edit-target-ambiguous:${path}`,
            diagnostic: {
              kind: "edit-target-ambiguous",
              evidence: [`oldText 在目标文件中出现 ${count} 次: ${path}`],
              nextActions: [
                `重新调用 read 读取 ${path} 的当前内容`,
                "扩大 oldText 上下文，使目标片段在文件中唯一",
                "不得改用 write 整体覆盖现有文件",
              ],
            },
          },
        }
      }
      content = content.replace(oldText, newText)
      atomicWriteText(abs, content)
      return { success: true, data: { path, replaced: count } }
    } catch (err: any) { return { success: false, error: err.message } }
  },
  contract: { effects: ["workspace-write"], idempotency: "non-idempotent", cancellation: "unsupported", progress: { role: "mutation", targetParameters: ["path"] } }, permission: "edit",
})

// ── move ──
export const moveTool = defineTool({
  name: "move",
  description: "在当前工作区内移动或重命名文件/目录。源路径和目标路径都必须位于工作区内，且不会覆盖已有目标；简单重命名不要输出 PowerShell/bash 命令让用户手动执行，直接调用本工具。",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "原路径（相对于工作目录）" },
      destination: { type: "string", description: "新路径（相对于工作目录）" },
    },
    required: ["source", "destination"],
  },
  async execute({ source, destination }: { source: string; destination: string }, ctx) {
    try {
      if (!source?.trim() || !destination?.trim()) {
        return { success: false, error: "source 和 destination 不能为空" }
      }
      const sourcePath = safePath(ctx.workingDir, source)
      const destinationPath = safePath(ctx.workingDir, destination)
      if (sourcePath === destinationPath) {
        return { success: true, data: { source, destination, unchanged: true } }
      }
      if (!existsSync(sourcePath)) return { success: false, error: `源路径不存在: ${source}` }
      if (existsSync(destinationPath)) return { success: false, error: `目标路径已存在，未覆盖: ${destination}` }
      mkdirSync(dirname(destinationPath), { recursive: true })
      renameSync(sourcePath, destinationPath)
      return { success: true, data: { source, destination } }
    } catch (err: any) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  contract: {
    effects: ["workspace-read", "workspace-write"],
    idempotency: "non-idempotent",
    cancellation: "unsupported",
    progress: { role: "mutation", targetParameters: ["source", "destination"] },
  },
  permission: "write",
})

// ── glob ──
export const globTool = defineTool({
  name: "glob",
  description: "按一个或多个文件名模式搜索文件（支持 * 和 **）；多个模式会在一次目录扫描中完成，批量搜索应优先使用 patterns。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "文件匹配模式，如 *.c 或 src/**/*.h" },
      patterns: { type: "array", items: { type: "string" }, description: "多个文件匹配模式，如 [\"**/*.c\", \"**/*.h\", \"**/*.pdf\"]" },
    },
  },
  async execute({ pattern, patterns }: { pattern?: string; patterns?: string[] }, ctx) {
    try {
      const requested = [...(Array.isArray(patterns) ? patterns : []), ...(typeof pattern === "string" ? [pattern] : [])]
        .map((value) => value.trim()).filter(Boolean).slice(0, 30)
      if (requested.length === 0) return { success: false, error: "至少需要一个 pattern 或 patterns" }
      const base = resolve(ctx.workingDir)
      const matchers = requested.map(compileGlobPattern)
      const buckets = requested.map(() => [] as string[])
       await walk(base, matchers, base, buckets, ctx.abortSignal)
      const matches = requested.map((value, index) => ({ pattern: value, files: buckets[index] }))
      return { success: true, data: { files: [...new Set(buckets.flat())].slice(0, 1_000), matches } }
    } catch (err: any) { return { success: false, error: err.message } }
  },
  contract: {
    effects: ["workspace-read"],
    idempotency: "read-only",
    cancellation: "cooperative",
    progress: { role: "inspection", targetParameters: ["pattern", "patterns"] },
  },
  permission: "read",
})

const SKIPPED_SCAN_DIRS = new Set([".git", ".svn", "node_modules", ".cache", "__pycache__"])

async function walk(dir: string, patterns: RegExp[], base: string, buckets: string[][], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("文件扫描已取消")
  if (buckets.every((bucket) => bucket.length >= 100)) return
  let entries: string[] = []
  try { entries = await readdirAsync(dir) } catch { return }
  for (const name of entries) {
    if (signal?.aborted) throw new Error("文件扫描已取消")
    const full = join(dir, name)
    const rel = relative(base, full).replace(/\\/g, "/")
    try {
      const link = await lstatAsync(full)
      if (link.isSymbolicLink()) continue
      const s = await statAsync(full)
      if (s.isDirectory()) {
        if (!SKIPPED_SCAN_DIRS.has(name)) await walk(full, patterns, base, buckets, signal)
      } else {
        for (let index = 0; index < patterns.length; index++) {
          if (buckets[index].length < 100 && patterns[index].test(rel)) buckets[index].push(rel)
        }
      }
    } catch { /* skip */ }
  }
}

function compileGlobPattern(pattern: string): RegExp {
  return new RegExp(
    "^" + pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/?/g, "(.+/)?")
      .replace(/\*/g, "[^/]*")
      + "$"
  )
}

// ── grep ──
export const grepTool = defineTool({
  name: "grep",
  description: "在文件中搜索文本内容（支持正则表达式）。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词或正则表达式" },
      path: { type: "string", description: "搜索路径（文件或目录，相对于工作目录）" },
    },
    required: ["query"],
  },
  async execute({ query, path }: { query: string; path?: string }, ctx) {
    try {
      const base = resolve(ctx.workingDir)
      const target = path ? safePath(base, path) : base
      const results: Array<{ file: string; line: number; text: string }> = []
      await grepIn(target, query, base, results, ctx.abortSignal)
      return { success: true, data: { matches: results.slice(0, 50) } }
    } catch (err: any) { return { success: false, error: err.message } }
  },
  contract: {
    effects: ["workspace-read"],
    idempotency: "read-only",
    cancellation: "cooperative",
    progress: { role: "inspection", targetParameters: ["path"] },
  },
  permission: "read",
})

async function grepIn(target: string, query: string, base: string, out: Array<{ file: string; line: number; text: string }>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("内容搜索已取消")
  if (out.length >= 50) return
  let s
  try {
    if ((await lstatAsync(target)).isSymbolicLink()) return
    s = await statAsync(target)
  } catch { return }
  if (s.isDirectory()) {
    const entries = await readdirAsync(target)
    for (const e of entries) {
      if (SKIPPED_SCAN_DIRS.has(e)) continue
      await grepIn(join(target, e), query, base, out, signal)
      if (out.length >= 50) return
    }
  } else if (s.isFile() && s.size < 200_000) {
    try {
      const content = await readFileAsync(target, "utf-8")
      const lines = content.split("\n")
      const re = safeRegex(query)
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push({ file: relative(base, target).replace(/\\/g, "/"), line: i + 1, text: lines[i].slice(0, 200) })
          if (out.length >= 50) return
        }
      }
    } catch { /* skip binary */ }
  }
}

function safeRegex(q: string): RegExp {
  const query = q.length > 200 ? q.slice(0, 200) : q
  if (/\\[1-9]|\(\?[:=!<]|(?:\*|\+|\{\d+,?\})[^\n]{0,12}(?:\*|\+|\{\d+,?\})/.test(query)) {
    throw new Error("正则表达式包含可能导致灾难性回溯的结构，请改用更具体的简单模式")
  }
  try { return new RegExp(query, "i") } catch { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
}

function atomicWriteText(path: string, content: string): void {
  const temporary = `${path}.eval-${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, "utf8")
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
