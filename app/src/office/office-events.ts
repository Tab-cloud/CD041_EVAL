import type { OfficeActivity, OfficeSnapshot } from "./types"
import { recordOfficeActivity } from "./office-stats"

const agents = new Map<string, OfficeActivity>()
const timeline: OfficeActivity[] = []
const listeners = new Set<(snapshot: OfficeSnapshot) => void>()

export function publishOfficeActivity(activity: OfficeActivity): void {
  const previous = agents.get(activity.runId)
  const next = { ...activity, timestamp: activity.timestamp || Date.now() }
  agents.set(activity.runId, next)
  const shouldRecord = !previous
    || previous.state !== next.state
    || previous.toolName !== next.toolName
    || (previous.activity !== next.activity && next.timestamp - previous.timestamp > 5_000)
  if (shouldRecord) {
    timeline.unshift(next)
    if (timeline.length > 80) timeline.length = 80
    recordOfficeActivity(next)
  }
  notify()
}

export function subscribeOffice(listener: (snapshot: OfficeSnapshot) => void): () => void {
  listeners.add(listener)
  listener(snapshot())
  return () => listeners.delete(listener)
}

export function getOfficeSnapshot(): OfficeSnapshot {
  return snapshot()
}

export function clearOfficeSession(sessionId: string): void {
  for (const [id, agent] of agents) if (agent.sessionId === sessionId) agents.delete(id)
  for (let index = timeline.length - 1; index >= 0; index--) {
    if (timeline[index].sessionId === sessionId) timeline.splice(index, 1)
  }
  notify()
}

function snapshot(): OfficeSnapshot {
  return { agents: [...agents.values()], timeline: [...timeline] }
}

function notify(): void {
  const value = snapshot()
  for (const listener of listeners) listener(value)
}
