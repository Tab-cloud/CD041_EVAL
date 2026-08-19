import { useEffect, useRef } from "react"
import { apiFetch } from "../api"
import { awardOfficeCompletion, type OfficeCompletionReward } from "../office/office-progression"
import type { OfficeActivity } from "../office/types"
import type { AgentInfo } from "../types"
import { playCompletionTone, publishTaskActivity } from "./agentOfficeHelpers"

interface OfficeRuntimeSyncOptions {
  activeSessionId: string | null
  agents: AgentInfo[]
  visibleAgents: OfficeActivity[]
  sound: boolean
  onReward: (reward: (OfficeCompletionReward & { agentName: string }) | null) => void
}

export function useOfficeRuntimeSync({
  activeSessionId,
  agents,
  visibleAgents,
  sound,
  onReward,
}: OfficeRuntimeSyncOptions): void {
  const completedRef = useRef(new Set<string>())

  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    const sync = async () => {
      try {
        const response = await apiFetch(`/api/tasks?sessionId=${encodeURIComponent(activeSessionId)}`)
        const data = await response.json() as {
          running?: Parameters<typeof publishTaskActivity>[0][]
          queued?: Parameters<typeof publishTaskActivity>[0][]
          tasks?: Parameters<typeof publishTaskActivity>[0][]
        }
        if (cancelled) return
        const tasks = [
          ...(data.running ?? []),
          ...(data.queued ?? []),
          ...(data.tasks ?? []).slice(0, 12),
        ]
        for (const task of tasks) publishTaskActivity(task, agents)
      } catch {
        // 办公室轮询失败不影响主界面
      }
    }
    void sync()
    const timer = setInterval(sync, 2_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeSessionId, agents])

  useEffect(() => {
    if (!sound) return
    for (const agent of visibleAgents) {
      if (agent.state !== "completed" || completedRef.current.has(agent.runId)) continue
      completedRef.current.add(agent.runId)
      playCompletionTone()
    }
  }, [sound, visibleAgents])

  useEffect(() => {
    for (const agent of visibleAgents) {
      if (agent.synthetic || agent.state !== "completed") continue
      const completion = awardOfficeCompletion(agent.runId, agent.timestamp)
      if (completion) onReward({ ...completion, agentName: agent.agentName ?? agent.agentId })
    }
  }, [onReward, visibleAgents])
}
