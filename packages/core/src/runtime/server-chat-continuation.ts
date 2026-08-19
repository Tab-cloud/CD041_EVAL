import type { ExecutionSnapshot } from "./agent-loop-control.ts"
import { processAttachments } from "./server-attachments.ts"
import { SessionCommandRepo, type SessionCommandView } from "../store/session-command.ts"
import { TaskRunRepo } from "../store/task-run.ts"

type ProcessedAttachments = Awaited<ReturnType<typeof processAttachments>>

export interface ContinuationResources {
  attachments: ProcessedAttachments
  requestIds: string[]
  sourceMessage?: string
}

interface ContinuationResourceDependencies {
  getTask: typeof TaskRunRepo.get
  getCommand: typeof SessionCommandRepo.get
  listCommands: typeof SessionCommandRepo.listBySession
  process: typeof processAttachments
}

const productionDependencies: ContinuationResourceDependencies = {
  getTask: TaskRunRepo.get.bind(TaskRunRepo),
  getCommand: SessionCommandRepo.get.bind(SessionCommandRepo),
  listCommands: SessionCommandRepo.listBySession.bind(SessionCommandRepo),
  process: processAttachments,
}

/**
 * Restores the durable resources owned by an objective when a later
 * "continue" command contains no attachment payload of its own.
 *
 * New snapshots carry exact request ids. Legacy snapshots are migrated by
 * searching only the same session and preferring attachment names already
 * present in the target-bound evidence ledger. Raw bytes remain in the
 * immutable SessionCommand; the execution snapshot stores references only.
 */
export async function resolveContinuationResources(input: {
  currentAttachments: ProcessedAttachments
  currentRequestId: string
  sessionId: string
  workingDir: string
  resumeTaskId?: string
  snapshot?: ExecutionSnapshot
  dependencies?: Partial<ContinuationResourceDependencies>
}): Promise<ContinuationResources> {
  if (input.currentAttachments.length > 0) {
    return {
      attachments: input.currentAttachments,
      requestIds: [input.currentRequestId],
    }
  }
  if (!input.snapshot && !input.resumeTaskId) return { attachments: [], requestIds: [] }

  const dependencies = { ...productionDependencies, ...input.dependencies }
  const exactRequestIds = collectExactRequestIds(
    input.snapshot,
    input.resumeTaskId,
    input.sessionId,
    dependencies,
  )
  for (const requestId of exactRequestIds) {
    const command = dependencies.getCommand(requestId)
    const restored = await processCommandResources(command, input, dependencies)
    if (restored.attachments.length > 0) {
      return { ...restored, requestIds: [requestId] }
    }
  }

  // One-time migration for snapshots created before resourceRequestIds
  // existed. This never crosses the session boundary and only considers
  // immutable commands that predate the continuation.
  const expectedTargets = expectedAttachmentTargets(input.snapshot)
  for (const command of dependencies.listCommands(input.sessionId, 200)) {
    if (command.requestId === input.currentRequestId || exactRequestIds.includes(command.requestId)) continue
    const raw = rawAttachments(command)
    if (raw.length === 0 || !matchesExpectedAttachment(raw, expectedTargets)) continue
    const restored = await dependencies.process(raw, input.workingDir)
    if (restored.length > 0) {
      return {
        attachments: restored,
        requestIds: [command.requestId],
        sourceMessage: commandMessage(command),
      }
    }
  }
  return {
    attachments: [],
    requestIds: input.snapshot?.resourceRequestIds?.slice(0, 20) ?? [],
  }
}

function collectExactRequestIds(
  snapshot: ExecutionSnapshot | undefined,
  resumeTaskId: string | undefined,
  sessionId: string,
  dependencies: ContinuationResourceDependencies,
): string[] {
  const result = new Set(
    (snapshot?.resourceRequestIds ?? []).filter((value): value is string => typeof value === "string" && Boolean(value)),
  )
  let taskId = resumeTaskId
  const visited = new Set<string>()
  while (taskId && visited.size < 32 && !visited.has(taskId)) {
    visited.add(taskId)
    const task = dependencies.getTask(taskId)
    if (!task || task.sessionId !== sessionId) break
    if (task.requestId) result.add(task.requestId)
    taskId = task.retryOf
  }
  return [...result]
}

async function processCommandResources(
  command: SessionCommandView | null,
  input: Pick<Parameters<typeof resolveContinuationResources>[0], "sessionId" | "workingDir">,
  dependencies: ContinuationResourceDependencies,
): Promise<{ attachments: ProcessedAttachments; sourceMessage?: string }> {
  if (!command || command.sessionId !== input.sessionId) return { attachments: [] }
  const raw = rawAttachments(command)
  return {
    attachments: raw.length > 0 ? await dependencies.process(raw, input.workingDir) : [],
    sourceMessage: commandMessage(command),
  }
}

function rawAttachments(command: SessionCommandView): any[] {
  try {
    const payload = JSON.parse(command.payload) as { attachments?: unknown }
    return Array.isArray(payload.attachments) ? payload.attachments : []
  } catch {
    return []
  }
}

function commandMessage(command: SessionCommandView): string | undefined {
  try {
    const payload = JSON.parse(command.payload) as { message?: unknown }
    return typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : undefined
  } catch {
    return undefined
  }
}

function expectedAttachmentTargets(snapshot: ExecutionSnapshot | undefined): string[] {
  return [...new Set((snapshot?.objectiveEvidenceBindings ?? [])
    .flatMap((binding) => binding.targets)
    .map(normalizeTarget)
    .filter(Boolean))]
}

function matchesExpectedAttachment(raw: any[], targets: string[]): boolean {
  if (targets.length === 0) return true
  return raw.some((attachment) => {
    const name = normalizeTarget(typeof attachment?.name === "string" ? attachment.name : "")
    if (!name) return false
    return targets.some((target) =>
      target === name
      || target.endsWith(`/${name}`)
      || target.includes(name)
      || globMatches(target, name))
  })
}

function normalizeTarget(value: string): string {
  return value.trim().replaceAll("\\", "/").toLowerCase()
}

function globMatches(pattern: string, value: string): boolean {
  let source = "^"
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    const next = pattern[index + 1]
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?"
        index += 2
      } else {
        source += ".*"
        index += 1
      }
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
  }
  return new RegExp(`${source}$`, "i").test(value)
}
