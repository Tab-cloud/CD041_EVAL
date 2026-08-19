import type { ExecutionSnapshot } from "./agent-loop-control.ts"
import { ExecutionRunRepo } from "../store/execution-run.ts"
import { TaskRunRepo } from "../store/task-run.ts"
import { SessionArtifactRepo, type SessionArtifact } from "../store/session-artifact.ts"
import { currentFileHash, normalizeArtifactSource } from "./session-artifact-projection.ts"

/**
 * A resumed task is a continuation of the same objective, not an unrelated run.
 * Once the continuation passes acceptance, close every ancestor execution so an
 * old blocked snapshot cannot remain the session's authoritative context state.
 */
export function resolveCompletedExecutionLineage(
  sourceTaskId: string | undefined,
  sessionId: string,
  snapshot: ExecutionSnapshot,
): void {
  let current = sourceTaskId
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    const execution = ExecutionRunRepo.get(current)
    if (!execution || execution.sessionId !== sessionId) break
    ExecutionRunRepo.save(current, sessionId, {
      ...snapshot,
      state: "completed",
      stopReason: undefined,
      updatedAt: Date.now(),
    })
    current = TaskRunRepo.get(current)?.retryOf
  }
}

export function persistSchematicConversationSummaries(
  sessionId: string,
  toolResults: Array<{ name?: string; result?: unknown }>,
  response: string,
  workingDir?: string,
): SessionArtifact[] {
  const analysis = cleanSchematicSummary(response)
  if (!analysis) return []

  const byFile = new Map<string, Array<Record<string, unknown>>>()
  for (const toolResult of toolResults) {
    if (toolResult.name !== "schematic_read" || !toolResult.result || typeof toolResult.result !== "object") continue
    const result = toolResult.result as Record<string, unknown>
    if (typeof result.analysis !== "string") continue
    const filePath = normalizeArtifactSource(String(result.filePath ?? ""), workingDir)
    if (!filePath) continue
    const pages = byFile.get(filePath) ?? []
    pages.push(result)
    byFile.set(filePath, pages)
  }

  const summaries: SessionArtifact[] = []
  for (const [filePath, pageResults] of byFile) {
    const pageNumbers = new Set(pageResults.map((result) => normalizedPageNumber(result.pageNumber)))
    if (pageNumbers.size < 2) continue
    const first = pageResults[0]
    summaries.push(SessionArtifactRepo.upsert({
      sessionId,
      kind: "schematic-summary",
      source: filePath,
      content: redactSchematicDiagnostics(analysis, pageResults),
      metadata: {
        pageCount: pageNumbers.size,
        fileSize: typeof first.fileSize === "string" ? first.fileSize : undefined,
      },
      sourceHash: currentFileHash(filePath),
    }))
  }
  return summaries
}

function normalizedPageNumber(value: unknown): number {
  const page = Number(value)
  return Number.isInteger(page) && page > 0 ? page : 1
}

function cleanSchematicSummary(response: string): string {
  return response
    .replace(/^\s*正在分析原理图(?:\.{3}|…{1,3})\s*/u, "")
    .trim()
}

function redactSchematicDiagnostics(text: string, results: Array<Record<string, unknown>>): string {
  let safe = text
    .replace(/`?visionUsed`?\s*[:=]\s*`?(?:true|false)`?/gi, "图像分析状态已确认")
    .replace(/`?(?:modelId|modelProvider|renderEngine)`?\s*[:=]\s*`?[^\s,，)）]+`?/gi, "内部诊断信息")
  const values = new Set<string>()
  for (const result of results) {
    for (const key of ["model", "modelId", "modelProvider"]) {
      const value = result[key]
      if (typeof value === "string" && value.trim().length >= 3) values.add(value.trim())
    }
  }
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    safe = safe.replace(new RegExp(escapeRegExp(value), "gi"), "视觉分析服务")
  }
  return safe
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
