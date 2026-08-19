import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, extname, isAbsolute, relative } from "node:path"
import {
  SessionArtifactRepo,
  type SessionArtifact,
  type SessionArtifactSnapshot,
} from "../store/session-artifact.ts"
import { TaskRunRepo, type TaskRunView } from "../store/task-run.ts"

export type DeliveredFileCategory =
  | "source"
  | "document"
  | "presentation"
  | "spreadsheet"
  | "pdf"
  | "firmware"
  | "image"
  | "other"

export interface DeliveredFile {
  artifactId: string
  name: string
  path: string
  relativePath: string
  extension: string
  category: DeliveredFileCategory
  size: number
  exists: boolean
  stale: boolean
  updatedAt: number
}

export interface DeliveryLineage {
  runId: string
  rootRunId: string
  requestId?: string
}

const SOURCE_EXTENSIONS = new Set([
  ".asm", ".c", ".cc", ".cmake", ".cpp", ".cs", ".css", ".go", ".h", ".hpp",
  ".html", ".ino", ".java", ".js", ".jsx", ".kt", ".kts", ".ld", ".lua",
  ".php", ".py", ".rb", ".rs", ".s", ".scss", ".sh", ".sql", ".swift",
  ".ts", ".tsx", ".vue",
])
const DOCUMENT_EXTENSIONS = new Set([
  ".adoc", ".doc", ".docx", ".json", ".md", ".mdx", ".pdf", ".rst", ".rtf",
  ".tex", ".toml", ".txt", ".xml", ".yaml", ".yml",
])
const PRESENTATION_EXTENSIONS = new Set([".ppt", ".pptx"])
const SPREADSHEET_EXTENSIONS = new Set([".csv", ".ods", ".xls", ".xlsx"])
const FIRMWARE_EXTENSIONS = new Set([".bin", ".elf", ".hex", ".map", ".uf2"])
const IMAGE_EXTENSIONS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"])
const SPECIAL_SOURCE_NAMES = new Set([
  "cmakelists.txt", "dockerfile", "gemfile", "makefile", "meson.build",
  "package.json", "pyproject.toml",
])

export function resolveDeliveryLineage(runId?: string): DeliveryLineage | undefined {
  if (!runId) return
  const run = TaskRunRepo.get(runId)
  if (!run) return
  let root = run
  const visited = new Set<string>()
  while (root.parentRunId && !visited.has(root.id)) {
    visited.add(root.id)
    const parent = TaskRunRepo.get(root.parentRunId)
    if (!parent || parent.sessionId !== run.sessionId) break
    root = parent
  }
  return {
    runId,
    rootRunId: root.id,
    requestId: root.requestId,
  }
}

export function deliveryFileCategory(path: string): DeliveredFileCategory | undefined {
  const name = basename(path).toLowerCase()
  const extension = extname(name).toLowerCase()
  if (SPECIAL_SOURCE_NAMES.has(name) || SOURCE_EXTENSIONS.has(extension)) return "source"
  if (extension === ".pdf") return "pdf"
  if (PRESENTATION_EXTENSIONS.has(extension)) return "presentation"
  if (SPREADSHEET_EXTENSIONS.has(extension)) return "spreadsheet"
  if (FIRMWARE_EXTENSIONS.has(extension)) return "firmware"
  if (IMAGE_EXTENSIONS.has(extension)) return "image"
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document"
  return undefined
}

export function isDocumentDelivery(path: string): boolean {
  const category = deliveryFileCategory(path)
  return category === "document"
    || category === "pdf"
    || category === "presentation"
    || category === "spreadsheet"
}

export function projectDeliveredFiles(
  snapshot: SessionArtifactSnapshot,
  rootRunId: string,
  workspaceRoot: string,
): DeliveredFile[] {
  const newestByPath = new Map<string, SessionArtifact>()
  for (const artifact of snapshot.artifacts) {
    if (artifact.kind !== "delivery-file") continue
    if (artifact.metadata.rootRunId !== rootRunId) continue
    if (!deliveryFileCategory(artifact.source)) continue
    const relativePath = relative(workspaceRoot, artifact.source)
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../")) {
      continue
    }
    const key = artifact.source.toLowerCase()
    const current = newestByPath.get(key)
    if (!current || artifact.updatedAt >= current.updatedAt) newestByPath.set(key, artifact)
  }

  return [...newestByPath.values()]
    .map((artifact): DeliveredFile => {
      const category = deliveryFileCategory(artifact.source) ?? "other"
      const stat = safeFileStat(artifact.source)
      const liveHash = stat ? fileHash(artifact.source) : undefined
      return {
        artifactId: artifact.id,
        name: artifact.title || basename(artifact.source),
        path: artifact.source,
        relativePath: relative(workspaceRoot, artifact.source).replaceAll("\\", "/"),
        extension: extname(artifact.source).slice(1).toLowerCase(),
        category,
        size: stat?.size ?? numberMetadata(artifact.metadata.size),
        exists: Boolean(stat),
        stale: Boolean(artifact.sourceHash && liveHash && artifact.sourceHash !== liveHash),
        updatedAt: artifact.updatedAt,
      }
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "zh-CN"))
}

export function deliveredFilesForTask(task: TaskRunView | null): DeliveredFile[] {
  if (!task || task.status !== "completed") return []
  return projectDeliveredFiles(
    SessionArtifactRepo.snapshot(task.sessionId),
    task.id,
    task.workingDir,
  )
}


export function finalizeDeliveredFiles(task: TaskRunView | null): DeliveredFile[] {
  const files = deliveredFilesForTask(task)
  if (!task || files.length === 0) return files
  SessionArtifactRepo.upsert({
    sessionId: task.sessionId,
    kind: "delivery-manifest",
    source: `run:${task.id}`,
    slot: "final",
    title: "任务交付文件",
    content: JSON.stringify(files.map((file) => file.artifactId)),
    metadata: {
      rootRunId: task.id,
      requestId: task.requestId,
      workspaceRoot: task.workingDir,
      count: files.length,
      completedAt: task.completedAt ?? Date.now(),
    },
  })
  return files
}

export function deliveredFilesForRequest(sessionId: string, requestId: string): DeliveredFile[] {
  if (!sessionId || !requestId) return []
  const snapshot = SessionArtifactRepo.snapshot(sessionId)
  const manifest = snapshot.artifacts
    .filter((artifact) =>
      artifact.kind === "delivery-manifest"
      && artifact.metadata.requestId === requestId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!manifest) return []
  const rootRunId = stringMetadata(manifest.metadata.rootRunId)
  const workspaceRoot = stringMetadata(manifest.metadata.workspaceRoot)
  if (!rootRunId || !workspaceRoot) return []
  return projectDeliveredFiles(snapshot, rootRunId, workspaceRoot)
}

function stringMetadata(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
function safeFileStat(path: string): { size: number } | undefined {
  try {
    if (!existsSync(path)) return
    const stat = statSync(path)
    return stat.isFile() ? { size: stat.size } : undefined
  } catch {
    return
  }
}

function fileHash(path: string): string | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) return
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return
  }
}

function numberMetadata(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}
