import type { ConversationTurnKind } from "./conversation-turn-intent.ts"

export type ConversationExecutionAuthority = "status" | "response-only" | "operational"

/**
 * Resolve the single authority boundary that decides whether a turn may mutate
 * external state. Downstream semantic classification may specialize an
 * operational request, but it must never downgrade that request back to a chat
 * response merely because the deliverable happens to be a plan or document.
 */
export function resolveConversationExecutionAuthority(
  turnKind: ConversationTurnKind,
): ConversationExecutionAuthority {
  if (turnKind === "status-query") return "status"
  if (turnKind === "domain-query" || turnKind === "conversation") return "response-only"
  return "operational"
}
