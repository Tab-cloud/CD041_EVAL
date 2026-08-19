import type { DeliveredFile, DeliveredFileCategory } from "./types"

const CATEGORIES = new Set<DeliveredFileCategory>([
  "source", "document", "presentation", "spreadsheet", "pdf", "firmware", "image", "other",
])

export function normalizeDeliveredFiles(value: unknown): DeliveredFile[] {
  if (!Array.isArray(value)) return []
  const byPath = new Map<string, DeliveredFile>()
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const candidate = item as Record<string, unknown>
    const path = stringValue(candidate.path)
    const name = stringValue(candidate.name)
    if (!path || !name) continue
    const category = CATEGORIES.has(candidate.category as DeliveredFileCategory)
      ? candidate.category as DeliveredFileCategory
      : "other"
    byPath.set(path.toLowerCase(), {
      artifactId: stringValue(candidate.artifactId) || path,
      name,
      path,
      relativePath: stringValue(candidate.relativePath) || name,
      extension: stringValue(candidate.extension).toLowerCase(),
      category,
      size: finiteNumber(candidate.size),
      exists: candidate.exists !== false,
      stale: candidate.stale === true,
      updatedAt: finiteNumber(candidate.updatedAt),
    })
  }
  return [...byPath.values()]
}

export async function openDeliveredFile(file: DeliveredFile): Promise<void> {
  if (!file.exists) throw new Error("交付文件已不存在")
  const { Command } = await import("@tauri-apps/plugin-shell")
  const output = await Command.create("explorer", [file.path]).execute()
  if (output.code !== 0) throw new Error(output.stderr || `无法打开文件（退出码 ${output.code}）`)
}

export function formatDeliveredFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${trimSize(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${trimSize(bytes / (1024 * 1024))} MB`
  return `${trimSize(bytes / (1024 * 1024 * 1024))} GB`
}

function trimSize(value: number): string {
  return value >= 10 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function finiteNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}
