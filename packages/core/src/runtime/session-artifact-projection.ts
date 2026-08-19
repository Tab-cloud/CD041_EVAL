import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"
import { SessionArtifactRepo, type SessionArtifact } from "../store/session-artifact.ts"
import type { ToolContext, ToolResult } from "../tool/types.ts"
import {
  deliveryFileCategory,
  isDocumentDelivery,
  resolveDeliveryLineage,
} from "./delivered-files.ts"

export function projectToolResultArtifact(
  toolName: string,
  params: Record<string, unknown>,
  result: ToolResult,
  ctx: Pick<ToolContext, "sessionId" | "workingDir" | "runId">,
): SessionArtifact | undefined {
  if (!result.success || !result.data || typeof result.data !== "object") return
  const data = result.data as Record<string, unknown>
  try {
    if (toolName === "schematic_read" && typeof data.analysis === "string") {
      const source = normalizeArtifactSource(String(data.filePath ?? ""), ctx.workingDir)
      if (!source) return
      const { analysis: _analysis, filePath: _filePath, ...metadata } = data
      return SessionArtifactRepo.upsert({
        sessionId: ctx.sessionId,
        kind: "schematic-page",
        source,
        slot: `page:${normalizedPageNumber(data.pageNumber)}`,
        content: data.analysis,
        metadata,
        sourceHash: currentFileHash(source),
      })
    }
    if (toolName === "datasheet_read" && typeof data.summary === "string") {
      const source = normalizeArtifactSource(String(data.filePath ?? data.source ?? ""), ctx.workingDir)
      if (!source) return
      const { summary: _summary, filePath: _filePath, source: _source, title: _title, ...metadata } = data
      return SessionArtifactRepo.upsert({
        sessionId: ctx.sessionId,
        kind: "datasheet",
        source,
        title: String(data.title ?? data.filePath ?? "数据手册"),
        content: data.summary,
        metadata,
        sourceHash: currentFileHash(source),
      })
    }
    if (toolName === "compile" && Array.isArray(data.artifacts)) {
      let latest: SessionArtifact | undefined
      for (const item of data.artifacts) {
        if (!item || typeof item !== "object") continue
        const artifact = item as Record<string, unknown>
        if (artifact.valid === false || typeof artifact.path !== "string") continue
        const source = normalizeArtifactSource(artifact.path, ctx.workingDir)
        if (!deliveryFileCategory(source)) continue
        latest = projectDeliveryArtifact(toolName, source, ctx) ?? latest
      }
      return latest
    }


    if ((toolName === "write" || toolName === "write_office")
      && typeof params.path === "string"
      && typeof params.content === "string"
      && deliveryFileCategory(params.path)) {
      const source = normalizeArtifactSource(String(data.path ?? params.path), ctx.workingDir)
      const document = isDocumentDelivery(source)
        ? SessionArtifactRepo.upsert({
            sessionId: ctx.sessionId,
            kind: "document",
            source,
            title: fileName(source),
            content: params.content,
            metadata: {
              type: toolName === "write_office" ? String(params.format ?? "other") : documentType(params.path),
              generatedBy: toolName,
            },
            sourceHash: currentFileHash(source),
          })
        : undefined
      return projectDeliveryArtifact(toolName, source, ctx) ?? document
    }
    if (toolName === "edit" && typeof params.path === "string" && deliveryFileCategory(params.path)) {
      const source = normalizeArtifactSource(String(data.path ?? params.path), ctx.workingDir)
      const document = isTextDocumentPath(source)
        ? SessionArtifactRepo.upsert({
            sessionId: ctx.sessionId,
            kind: "document",
            source,
            title: fileName(source),
            content: readFileSync(source, "utf8"),
            metadata: { type: documentType(params.path), generatedBy: toolName },
            sourceHash: currentFileHash(source),
          })
        : undefined
      return projectDeliveryArtifact(toolName, source, ctx) ?? document
    }
  } catch {
    // Artifact projection is a read model. Tool execution remains authoritative.
  }
}

export function currentFileHash(path: string): string | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) return undefined
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return undefined
  }
}

export function normalizeArtifactSource(path: string, workingDir?: string): string {
  if (!path) return ""
  return resolve(workingDir ?? process.cwd(), path)
}

function normalizedPageNumber(value: unknown): number {
  const page = Number(value)
  return Number.isInteger(page) && page > 0 ? page : 1
}

function projectDeliveryArtifact(
  toolName: string,
  source: string,
  ctx: Pick<ToolContext, "sessionId" | "workingDir" | "runId">,
): SessionArtifact | undefined {
  const lineage = resolveDeliveryLineage(ctx.runId)
  const category = deliveryFileCategory(source)
  if (!lineage || !category) return
  const stat = statSync(source)
  if (!stat.isFile()) return
  return SessionArtifactRepo.upsert({
    sessionId: ctx.sessionId,
    kind: "delivery-file",
    source,
    slot: `run:${lineage.rootRunId}`,
    title: fileName(source),
    content: "",
    metadata: {
      ...lineage,
      category,
      generatedBy: toolName,
      relativePath: relative(ctx.workingDir, source).replaceAll("\\", "/"),
      workspaceRoot: ctx.workingDir,
      size: stat.size,
    },
    sourceHash: currentFileHash(source),
  })
}

function isTextDocumentPath(path: string): boolean {
  return /\.(?:md|mdx|txt|rst)$/i.test(path)
}

function documentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase()
  if (extension === "md" || extension === "mdx" || extension === "rst") return "reference"
  if (extension === "doc" || extension === "docx" || extension === "pdf") return "manual"
  return "other"
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}
