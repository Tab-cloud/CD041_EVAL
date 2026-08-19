import { createHash } from "node:crypto"
import type { ConversationContinuationMode } from "./conversation-turn-intent.ts"

export interface ResolvedConversationObjective {
  effectiveMessage: string
  confirmation: boolean
  unresolvedReference?: boolean
  sourceText?: string
  sourceMessageId?: string
  referencedTaskCount?: number
  tasks?: string[]
}

export interface ConversationObjectiveProposal {
  sourceMessageId?: string
  content: string
  taskCount: number
  tasks?: string[]
}

/** Stable semantic revision used to bind an execution snapshot to one objective version. */
export function conversationObjectiveFingerprint(
  objective: Pick<ConversationObjectiveProposal, "content" | "taskCount" | "tasks">,
): string {
  return createHash("sha256").update(JSON.stringify({
    content: objective.content.trim(),
    taskCount: objective.taskCount,
    tasks: objective.tasks?.map((task) => task.trim()) ?? [],
  })).digest("hex")
}

export function executionMatchesConversationObjective(
  execution: {
    conversationObjectiveId?: string
    conversationObjectiveFingerprint?: string
  } | null | undefined,
  objective: ConversationObjectiveProposal & { id: string },
): boolean {
  return Boolean(
    execution
    && execution.conversationObjectiveId === objective.id
    && execution.conversationObjectiveFingerprint === conversationObjectiveFingerprint(objective),
  )
}

export function resolveConversationObjectiveProposal(
  source: ConversationObjectiveProposal,
  referencedCount?: number,
): ResolvedConversationObjective {
  const sourceText = source.content
  return {
    confirmation: true,
    sourceText,
    sourceMessageId: source.sourceMessageId,
    referencedTaskCount: referencedCount,
    tasks: source.tasks,
    effectiveMessage: [
      "用户已确认执行此前主 Agent 明确列出的工作。",
      "所引用回复中的待办、验收条件和目标构成当前执行目标；不得再次询问是否执行。",
      "逐项执行、验证并在完成后交付结果。",
      "",
      "被引用的主 Agent 工作清单：",
      sourceText,
    ].join("\n"),
  }
}

/**
 * Compose one authoritative objective for a resumed turn.
 *
 * `continuationMode` is produced by the semantic turn interpreter. This keeps
 * language-specific "continue" keywords out of the scheduler while ensuring a
 * turn such as "continue, and explain every section in plain Chinese" cannot
 * be collapsed back to the old objective.
 *
 * Contract version 2 snapshots already contain the fully composed objective.
 * Legacy snapshots are migrated from the immutable task command and attachment
 * source message because older runs persisted only their control phrase.
 */
export function resolveContinuationObjectiveMessage(input: {
  currentMessage: string
  continuationMode: ConversationContinuationMode
  resumedObjective?: string
  resumeTaskMessage?: string
  resourceSourceMessage?: string
  continuationContractVersion?: number
}): string {
  const current = input.currentMessage.trim()
  const resumed = input.resumedObjective?.trim()
  const taskMessage = input.resumeTaskMessage?.trim()
  const resourceMessage = input.resourceSourceMessage?.trim()
  const base = input.continuationContractVersion && input.continuationContractVersion >= 2
    ? resumed || taskMessage || resourceMessage
    : taskMessage && resumed && taskMessage !== resumed
      ? taskMessage
      : resourceMessage || resumed || taskMessage

  if (input.continuationMode === "control-only") return base || current
  if (!base || base === current) return current
  return [
    "原任务目标：",
    base,
    "",
    "用户本轮新增或细化的要求：",
    current,
    "",
    "以上两部分构成同一个当前目标；执行与验收必须同时覆盖。",
  ].join("\n")
}
