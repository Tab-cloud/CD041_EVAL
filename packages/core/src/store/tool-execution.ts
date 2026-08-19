import { createHash, randomUUID } from "node:crypto"
import {
  existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { safePath } from "../tool/helpers"
import { getDb } from "./database"
import { isSensitiveKey, redactSensitiveData } from "../runtime/sensitive-data"
import type { ToolEvidenceAttestation, ToolOutcome } from "../tool/types.ts"

const MAX_SNAPSHOT_BYTES = 1024 * 1024
const MAX_DIFF_CHARS = 120_000
const MAX_RESULT_CHARS = 2 * 1024 * 1024
const MAX_EXECUTIONS_PER_SESSION = 100

export type ToolExecutionStatus = "running" | "succeeded" | "failed" | "denied"

export interface FileSnapshot {
  filePath: string
  absolutePath: string
  beforeExists: boolean
  beforeContent: string
}

export interface ToolExecutionView {
  id: string
  sessionId: string
  runId?: string
  parentRunId?: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  /** Runtime-issued evidence recovered from the durable tool result. */
  runtimeEvidence?: ToolEvidenceAttestation[]
  /** Runtime-owned structured outcome retained for diagnostics and recovery. */
  runtimeOutcome?: ToolOutcome
  status: ToolExecutionStatus
  filePath?: string
  diff?: string
  linesAdded: number
  linesRemoved: number
  reversible: boolean
  error?: string
  startedAt: number
  finishedAt?: number
  undoneAt?: number
}

export interface ToolExecutionStats {
  toolName: string
  calls: number
  succeeded: number
  failed: number
  averageLatencyMs: number
  lastUsedAt?: number
  lastError?: string
}

interface ToolExecutionRow {
  id: string
  session_id: string
  run_id: string | null
  parent_run_id: string | null
  tool_call_id: string
  tool_name: string
  tool_input: string
  result: string | null
  status: ToolExecutionStatus
  working_dir: string | null
  file_path: string | null
  before_exists: number | null
  before_content: string | null
  after_hash: string | null
  diff: string | null
  lines_added: number
  lines_removed: number
  reversible: number
  error: string | null
  started_at: number
  finished_at: number | null
  undone_at: number | null
}

export class ToolExecutionConflictError extends Error {}
export class ToolExecutionNotFoundError extends Error {}

export function captureFileSnapshot(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): FileSnapshot | null {
  if (toolName !== "write" && toolName !== "edit") return null
  if (typeof input.path !== "string" || !input.path.trim()) return null

  const absolutePath = safePath(workingDir, input.path)
  if (!existsSync(absolutePath)) {
    return { filePath: input.path, absolutePath, beforeExists: false, beforeContent: "" }
  }

  const stat = statSync(absolutePath)
  if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null
  const content = readFileSync(absolutePath, "utf8")
  if (content.includes("\0")) return null
  return { filePath: input.path, absolutePath, beforeExists: true, beforeContent: content }
}

export function buildUnifiedDiff(
  before: string,
  after: string,
  filePath = "file",
): { diff: string; added: number; removed: number } {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++

  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++

  const removedLines = oldLines.slice(prefix, oldLines.length - suffix)
  const addedLines = newLines.slice(prefix, newLines.length - suffix)
  if (removedLines.length === 0 && addedLines.length === 0) return { diff: "", added: 0, removed: 0 }
  const operations = lineOperations(removedLines, addedLines)
  const removed = operations.filter((operation) => operation.kind === "remove").length
  const added = operations.filter((operation) => operation.kind === "add").length

  const contextStart = Math.max(0, prefix - 3)
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3)
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3)
  const oldCount = oldEnd - contextStart
  const newCount = newEnd - contextStart
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`,
    ...oldLines.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...operations.map((operation) => `${operation.kind === "add" ? "+" : operation.kind === "remove" ? "-" : " "}${operation.line}`),
    ...newLines.slice(newLines.length - suffix, newEnd).map((line) => ` ${line}`),
  ]
  let diff = lines.join("\n")
  if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n... Diff 已截断`
  return { diff, added, removed }
}

export function restoreSnapshotIfUnchanged(snapshot: FileSnapshot, afterHash: string): void {
  if (!existsSync(snapshot.absolutePath) || hashFile(snapshot.absolutePath) !== afterHash) {
    throw new ToolExecutionConflictError("文件已在工具执行后发生变化，无法安全撤销")
  }
  if (!snapshot.beforeExists) {
    unlinkSync(snapshot.absolutePath)
    return
  }
  mkdirSync(dirname(snapshot.absolutePath), { recursive: true })
  writeFileSync(snapshot.absolutePath, snapshot.beforeContent, "utf8")
}

export const ToolExecutionRepo = {
  start(input: {
    sessionId: string
    runId?: string
    parentRunId?: string
    toolCallId: string
    agentId: string
    toolName: string
    toolInput: Record<string, unknown>
    workingDir: string
  }): ToolExecutionView {
    const id = randomUUID()
    const startedAt = Date.now()
    const safeInput = sanitizeInput(input.toolInput)
    getDb().run(
      `INSERT INTO tool_executions
       (id, session_id, run_id, parent_run_id, tool_call_id, agent_id, tool_name, tool_input, status, working_dir, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      [id, input.sessionId, input.runId ?? input.sessionId, input.parentRunId ?? null,
        input.toolCallId, input.agentId, input.toolName, JSON.stringify(safeInput), input.workingDir, startedAt],
    )
    getDb().run(
      `DELETE FROM tool_executions WHERE session_id = ? AND id NOT IN (
         SELECT id FROM tool_executions WHERE session_id = ? ORDER BY started_at DESC LIMIT ?
       )`,
      [input.sessionId, input.sessionId, MAX_EXECUTIONS_PER_SESSION],
    )
    return {
      id, sessionId: input.sessionId, runId: input.runId ?? input.sessionId,
      parentRunId: input.parentRunId, toolCallId: input.toolCallId,
      toolName: input.toolName, input: safeInput, status: "running",
      linesAdded: 0, linesRemoved: 0, reversible: false, startedAt,
    }
  },

  finish(
    id: string,
    options: {
      status: Exclude<ToolExecutionStatus, "running">
      result: unknown
      error?: string
      snapshot?: FileSnapshot | null
    },
  ): ToolExecutionView | null {
    const row = getRow(id)
    if (!row) return null
    const finishedAt = Date.now()
    let diff = ""
    let linesAdded = 0
    let linesRemoved = 0
    let afterHash: string | null = null
    let reversible = false

    if (options.status === "succeeded" && options.snapshot && existsSync(options.snapshot.absolutePath)) {
      const stat = statSync(options.snapshot.absolutePath)
      if (stat.isFile() && stat.size <= MAX_SNAPSHOT_BYTES) {
        const afterContent = readFileSync(options.snapshot.absolutePath, "utf8")
        if (!afterContent.includes("\0")) {
          const change = buildUnifiedDiff(options.snapshot.beforeContent, afterContent, options.snapshot.filePath)
          diff = change.diff
          linesAdded = change.added
          linesRemoved = change.removed
          afterHash = hashContent(afterContent)
          reversible = Boolean(diff)
        }
      }
    }

    getDb().run(
      `UPDATE tool_executions SET status = ?, file_path = ?, before_exists = ?, before_content = ?,
       after_hash = ?, diff = ?, lines_added = ?, lines_removed = ?, reversible = ?, result = ?, error = ?, finished_at = ?
       WHERE id = ?`,
      [
        options.status, options.snapshot?.filePath ?? null,
        options.snapshot ? Number(options.snapshot.beforeExists) : null,
        reversible ? options.snapshot?.beforeContent ?? null : null,
        afterHash, diff || null, linesAdded, linesRemoved, Number(reversible),
        serializeResult(options.result), options.error ?? null, finishedAt, id,
      ],
    )
    return toView(getRow(id)!)
  },

  listBySession(sessionId: string, limit = 100): ToolExecutionView[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, MAX_EXECUTIONS_PER_SESSION)) : 100
    const rows = getDb().query(
      "SELECT * FROM tool_executions WHERE session_id = ? ORDER BY started_at DESC LIMIT ?",
    ).all(sessionId, safeLimit) as ToolExecutionRow[]
    return rows.reverse().map(toView)
  },

  /**
   * Projects one root execution tree rather than the entire conversation.
   * Descendant tool rows are included through the durable task graph; public
   * projection still hides private child activity that produced no artifact.
   */
  listByRootRun(sessionId: string, rootRunId: string, limit = 100): ToolExecutionView[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, MAX_EXECUTIONS_PER_SESSION)) : 100
    const rows = getDb().query(
      `WITH RECURSIVE run_tree(id) AS (
         SELECT id FROM task_runs WHERE id = ? AND session_id = ?
         UNION ALL
         SELECT child.id
         FROM task_runs child
         JOIN run_tree parent ON child.parent_run_id = parent.id
         WHERE child.session_id = ?
       )
       SELECT * FROM tool_executions
       WHERE session_id = ? AND run_id IN (SELECT id FROM run_tree)
       ORDER BY started_at DESC
       LIMIT ?`,
    ).all(rootRunId, sessionId, sessionId, sessionId, safeLimit) as ToolExecutionRow[]
    return rows.reverse().map(toView)
  },

  listRecent(limit = 20): ToolExecutionView[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 20
    const rows = getDb().query("SELECT * FROM tool_executions ORDER BY started_at DESC LIMIT ?").all(safeLimit) as ToolExecutionRow[]
    return rows.map(toView)
  },

  failRunningByToolCalls(sessionId: string, toolCallIds: string[], error: string): ToolExecutionView[] {
    const ids = [...new Set(toolCallIds.filter(Boolean))]
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(",")
    const rows = getDb().query(
      `SELECT id FROM tool_executions
       WHERE session_id = ? AND status = 'running' AND tool_call_id IN (${placeholders})`,
    ).all(sessionId, ...ids) as Array<{ id: string }>
    if (rows.length === 0) return []
    const finishedAt = Date.now()
    getDb().run(
      `UPDATE tool_executions SET status = 'failed', error = ?, finished_at = ?
       WHERE session_id = ? AND status = 'running' AND tool_call_id IN (${placeholders})`,
      [error.slice(0, 2_000), finishedAt, sessionId, ...ids],
    )
    return rows.flatMap(({ id }) => {
      const row = getRow(id)
      return row ? [toView(row)] : []
    })
  },

  recoverInterrupted(): number {
    const result = getDb().run(
      `UPDATE tool_executions SET status = 'failed', error = ?, finished_at = ?
       WHERE status = 'running'`,
      ["Agent 服务已重启，工具执行被中断", Date.now()],
    )
    return result.changes
  },

  count(): number {
    return (getDb().query("SELECT COUNT(*) AS count FROM tool_executions").get() as { count: number }).count
  },

  stats(): ToolExecutionStats[] {
    const rows = getDb().query(
      `SELECT tool_name,
              COUNT(*) AS calls,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status IN ('failed','denied') THEN 1 ELSE 0 END) AS failed,
              AVG(CASE WHEN finished_at IS NOT NULL THEN finished_at - started_at END) AS average_latency,
              MAX(started_at) AS last_used_at
       FROM tool_executions GROUP BY tool_name ORDER BY calls DESC`,
    ).all() as Array<{ tool_name: string; calls: number; succeeded: number; failed: number; average_latency: number | null; last_used_at: number | null }>
    return rows.map((row) => {
      const error = getDb().query(
        `SELECT error FROM tool_executions
         WHERE tool_name = ? AND error IS NOT NULL AND error != '' ORDER BY started_at DESC LIMIT 1`,
      ).get(row.tool_name) as { error: string } | null
      return {
        toolName: row.tool_name,
        calls: row.calls,
        succeeded: row.succeeded,
        failed: row.failed,
        averageLatencyMs: Math.round(row.average_latency ?? 0),
        lastUsedAt: row.last_used_at ?? undefined,
        lastError: error?.error,
      }
    })
  },

  undo(id: string): ToolExecutionView {
    const row = getRow(id)
    if (!row) throw new ToolExecutionNotFoundError("工具执行记录不存在")
    if (row.status !== "succeeded" || !row.reversible || !row.after_hash || !row.file_path || !row.working_dir) {
      throw new ToolExecutionConflictError("该操作不可撤销")
    }
    if (row.undone_at) throw new ToolExecutionConflictError("该操作已经撤销")

    const snapshot: FileSnapshot = {
      filePath: row.file_path,
      absolutePath: safePath(row.working_dir, row.file_path),
      beforeExists: Boolean(row.before_exists),
      beforeContent: row.before_content ?? "",
    }
    restoreSnapshotIfUnchanged(snapshot, row.after_hash)
    getDb().run("UPDATE tool_executions SET undone_at = ?, reversible = 0 WHERE id = ?", [Date.now(), id])
    return toView(getRow(id)!)
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM tool_executions WHERE session_id = ?", [sessionId])
  },
}

function getRow(id: string): ToolExecutionRow | null {
  return getDb().query("SELECT * FROM tool_executions WHERE id = ?").get(id) as ToolExecutionRow | null
}

function toView(row: ToolExecutionRow): ToolExecutionView {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    parentRunId: row.parent_run_id ?? undefined,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    input: parseInput(row.tool_input),
    runtimeEvidence: parseRuntimeEvidence(row.result),
    runtimeOutcome: parseRuntimeOutcome(row.result),
    status: row.status,
    filePath: row.file_path ?? undefined,
    diff: row.diff ?? undefined,
    linesAdded: row.lines_added,
    linesRemoved: row.lines_removed,
    reversible: Boolean(row.reversible),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    undoneAt: row.undone_at ?? undefined,
  }
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  return sanitizeInputValue(input, "", 0) as Record<string, unknown>
}

function sanitizeInputValue(value: unknown, key: string, depth: number): unknown {
  if (isSensitiveKey(key)) return "[已脱敏]"
  if (depth >= 8) return "[内容过深]"
  if (["content", "oldText", "newText"].includes(key) && typeof value === "string") return `[${value.length} 字符]`
  if (typeof value === "string") return value.slice(0, 2_000)
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeInputValue(item, "", depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 200)
      .map(([childKey, childValue]) => [childKey, sanitizeInputValue(childValue, childKey, depth + 1)]))
  }
  return value
}

function parseInput(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
}

function parseRuntimeEvidence(value: string | null): ToolEvidenceAttestation[] {
  if (!value) return []
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return [] }
  if (!parsed || typeof parsed !== "object") return []
  const evidence = (parsed as Record<string, unknown>).runtimeEvidence
  if (!Array.isArray(evidence)) return []
  const kinds = new Set<ToolEvidenceAttestation["kind"]>([
    "plan-submission",
    "build-success",
    "test-success",
    "regression-test-success",
    "stress-test-success",
    "schematic-inspection",
    "datasheet-inspection",
    "source-inspection",
    "workspace-inspection",
    "external-research",
    "workspace-mutation",
    "process-verification",
    "hardware-observation",
  ])
  return evidence.flatMap((item): ToolEvidenceAttestation[] => {
    if (!item || typeof item !== "object") return []
    const candidate = item as Record<string, unknown>
    if (typeof candidate.kind !== "string"
      || !kinds.has(candidate.kind as ToolEvidenceAttestation["kind"])
      || typeof candidate.producer !== "string"
      || !Array.isArray(candidate.targets)) return []
    return [{
      kind: candidate.kind as ToolEvidenceAttestation["kind"],
      producer: candidate.producer.slice(0, 128),
      targets: candidate.targets
        .filter((target): target is string => typeof target === "string")
        .map((target) => target.slice(0, 2_000))
        .slice(0, 100),
    }]
  })
}

function parseRuntimeOutcome(value: string | null): ToolOutcome | undefined {
  if (!value) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return undefined }
  if (!parsed || typeof parsed !== "object") return undefined
  const outcome = (parsed as Record<string, unknown>).runtimeOutcome
  if (!outcome || typeof outcome !== "object") return undefined
  const candidate = outcome as Record<string, unknown>
  if (!["succeeded", "failed", "cancelled", "timed-out"].includes(String(candidate.status))
    || !["command", "build", "permission", "evidence", "generic"].includes(String(candidate.category))
    || typeof candidate.summary !== "string") return undefined
  return outcome as ToolOutcome
}

function serializeResult(result: unknown): string {
  try {
    const serialized = JSON.stringify(redactSensitiveData(result))
    return (serialized ?? String(result)).slice(0, MAX_RESULT_CHARS)
  } catch {
    return String(result).slice(0, MAX_RESULT_CHARS)
  }
}

function splitLines(value: string): string[] {
  if (!value) return []
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
}

function lineOperations(
  oldLines: string[],
  newLines: string[],
): Array<{ kind: "context" | "remove" | "add"; line: string }> {
  if (oldLines.length * newLines.length > 250_000) {
    return [
      ...oldLines.map((line) => ({ kind: "remove" as const, line })),
      ...newLines.map((line) => ({ kind: "add" as const, line })),
    ]
  }

  const columns = newLines.length + 1
  const table = new Uint32Array((oldLines.length + 1) * columns)
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const position = oldIndex * columns + newIndex
      table[position] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * columns + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * columns + newIndex], table[position + 1])
    }
  }

  const operations: Array<{ kind: "context" | "remove" | "add"; line: string }> = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({ kind: "context", line: oldLines[oldIndex] })
      oldIndex++
      newIndex++
    } else if (table[(oldIndex + 1) * columns + newIndex] >= table[oldIndex * columns + newIndex + 1]) {
      operations.push({ kind: "remove", line: oldLines[oldIndex++] })
    } else {
      operations.push({ kind: "add", line: newLines[newIndex++] })
    }
  }
  while (oldIndex < oldLines.length) operations.push({ kind: "remove", line: oldLines[oldIndex++] })
  while (newIndex < newLines.length) operations.push({ kind: "add", line: newLines[newIndex++] })
  return operations
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}
