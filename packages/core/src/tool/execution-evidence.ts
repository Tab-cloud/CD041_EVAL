import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, relative, resolve } from "node:path"
import type { ToolResult } from "./types.ts"

export interface EvidenceGateDecision {
  allowed: boolean
  kind?: "evidence-required" | "version-conflict"
  summary?: string
  requirements?: string[]
}

/**
 * Per-run evidence ledger. Mutating tools consult this ledger at the registry
 * boundary, so safety does not depend on whether a model followed a prompt.
 */
export class ExecutionEvidenceLedger {
  private readonly inspectedFiles = new Set<string>()
  private readonly inspectedVersions = new Map<string, string>()
  private readonly discoveredFiles = new Set<string>()

  constructor(private readonly workingDir: string) {}

  record(toolName: string, input: Record<string, unknown>, result: ToolResult): void {
    if (toolName === "read") {
      const payload = result.data as Record<string, unknown> | undefined
      for (const requested of stringArray(input.paths)) {
        const value = payload?.[requested]
        if (typeof value === "string" && !/^\[(?:路径不存在|读取失败)/.test(value)) {
          const normalized = this.normalize(requested)
          this.inspectedFiles.add(normalized)
          const version = versionOfObservedFile(this.workingDir, requested, value)
          if (version) this.inspectedVersions.set(normalized, version)
        }
      }
      return
    }
    if (!result.success) return
    if (toolName === "write" || toolName === "edit") {
      const requested = typeof input.path === "string" ? input.path : ""
      if (!requested) return
      const normalized = this.normalize(requested)
      const version = versionOfCurrentFile(this.workingDir, requested)
      if (version === "<missing-or-unreadable>") {
        this.inspectedFiles.delete(normalized)
        this.inspectedVersions.delete(normalized)
        return
      }
      // A successful mutation ran under the registry's workspace lock. Advance
      // the ledger to the version produced by this execution so a subsequent
      // edit is compared with our latest write, not the original read.
      this.inspectedFiles.add(normalized)
      this.inspectedVersions.set(normalized, version)
      return
    }
    if (toolName === "glob") {
      const files = (result.data as { files?: unknown } | undefined)?.files
      for (const file of stringArray(files)) this.discoveredFiles.add(this.normalize(file))
      return
    }
    if (toolName === "grep") {
      const matches = (result.data as { matches?: Array<{ file?: unknown }> } | undefined)?.matches
      for (const match of matches ?? []) {
        if (typeof match.file === "string") this.discoveredFiles.add(this.normalize(match.file))
      }
    }
  }

  authorize(toolName: string, input: Record<string, unknown>): EvidenceGateDecision {
    if (toolName !== "write" && toolName !== "edit") return { allowed: true }
    const requested = typeof input.path === "string" ? input.path : ""
    if (!requested) return { allowed: true }
    const target = this.normalize(requested)
    const targetExists = existsSync(resolve(this.workingDir, requested))

    if (targetExists && !this.inspectedFiles.has(target)) {
      return denied(
        `修改现有文件前必须读取当前内容: ${requested}`,
        [`调用 read 读取 ${requested}`, "基于最新内容执行精确修改"],
      )
    }


    const expectedVersion = this.inspectedVersions.get(target)
    if (expectedVersion) {
      const currentVersion = versionOfCurrentFile(this.workingDir, requested)
      if (currentVersion !== expectedVersion) {
        return denied(
          `文件在读取后已被其他执行修改: ${requested}`,
          [`重新调用 read 读取 ${requested}`, "基于最新版本重新生成修改，不得覆盖并发变更"],
          "version-conflict",
        )
      }
    }

    if (!targetExists && isCriticalBuildAsset(target)) {
      const family = criticalAssetFamily(target)
      const references = [...this.inspectedFiles].filter((path) => criticalAssetFamily(path) === family)
      if (references.length === 0) {
        return denied(
          `禁止在无证据时新建关键构建资产: ${requested}`,
          [
            `用 glob 查找项目或厂商 SDK 中已有的${criticalAssetLabel(family)}`,
            "用 read 读取至少一个与目标芯片和工具链匹配的参考文件",
            "优先复制并最小修改厂商资产，不得凭经验手写内存布局或启动约定",
          ],
        )
      }
    }
    return { allowed: true }
  }

  snapshot(): { inspected: string[]; discovered: string[] } {
    return { inspected: [...this.inspectedFiles], discovered: [...this.discoveredFiles] }
  }

  private normalize(path: string): string {
    const absolute = resolve(this.workingDir, path)
    return relative(resolve(this.workingDir), absolute).replace(/\\/g, "/").toLowerCase()
  }
}

type CriticalAssetFamily = "linker" | "build" | "startup" | "other"

export function isCriticalBuildAsset(path: string): boolean {
  return criticalAssetFamily(path) !== "other"
}

function criticalAssetFamily(path: string): CriticalAssetFamily {
  const normalized = path.replace(/\\/g, "/").toLowerCase()
  const name = normalized.split("/").at(-1) ?? normalized
  if ([".ld", ".sct", ".icf"].includes(extname(name))) return "linker"
  if (name === "makefile" || name.endsWith(".mk") || name === "cmakelists.txt") return "build"
  if (/^(?:startup|system_).+\.(?:c|s|asm)$/.test(name)) return "startup"
  return "other"
}

function criticalAssetLabel(family: CriticalAssetFamily): string {
  if (family === "linker") return "链接脚本"
  if (family === "build") return "构建配置"
  if (family === "startup") return "启动或系统文件"
  return "参考文件"
}

function denied(
  summary: string,
  requirements: string[],
  kind: EvidenceGateDecision["kind"] = "evidence-required",
): EvidenceGateDecision {
  return { allowed: false, summary, requirements, kind }
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function versionOfObservedFile(workingDir: string, path: string, observed: string): string | null {
  try {
    const absolute = resolve(workingDir, path)
    const stat = statSync(absolute)
    if (!stat.isFile() || stat.size > 200_000) return null
    // Plain text reads expose the exact bytes interpreted as UTF-8. Rich
    // document extraction is intentionally excluded from mutation evidence.
    if (/^\[(?:DOC|DOCX|XLSX|PPTX)/.test(observed)) return null
    return hash(observed)
  } catch {
    return null
  }
}

function versionOfCurrentFile(workingDir: string, path: string): string {
  try {
    return hash(readFileSync(resolve(workingDir, path), "utf8"))
  } catch {
    return "<missing-or-unreadable>"
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}
