import type { CompactSummary } from "./context-state"
import type { ChatMessage } from "./types"

/** Locate a compaction event in message history instead of pinning it to the live tail. */
export function compactDividerAfterIndex(messages: ChatMessage[], summary: CompactSummary | null): number | null {
  if (!summary) return null
  if (summary.throughSeq !== undefined && messages.some((message) => message.seq !== undefined)) {
    return findLastIndex(messages, (message) => message.seq !== undefined && message.seq <= summary.throughSeq!)
  }
  return findLastIndex(messages, (message) => message.timestamp <= summary.timestamp)
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) return index
  }
  return -1
}
