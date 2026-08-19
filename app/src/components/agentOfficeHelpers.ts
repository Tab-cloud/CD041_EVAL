import type { AgentInfo } from "../types"
import { publishOfficeActivity } from "../office/office-events"
import type { OfficeActivity } from "../office/types"

interface TaskView {
  id: string
  sessionId: string
  agentId?: string
  status: string
  message?: string
  createdAt?: number
  startedAt?: number
  completedAt?: number
  problem?: { message?: string }
}

export function publishTaskActivity(task: TaskView, agents: AgentInfo[]): void {
  const terminal = ["blocked", "completed", "failed", "cancelled", "interrupted"].includes(task.status)
  const state: OfficeActivity["state"] = task.status === "queued"
    ? "queued"
    : task.status === "blocked" || task.status === "waiting-approval"
      ? "waiting-human"
      : task.status === "failed" || task.status === "interrupted"
        ? "failed"
        : task.status === "completed"
          ? "completed"
          : task.status === "cancelled"
            ? "resting"
            : "executing"
  const agentId = task.agentId ?? "main-agent"
  publishOfficeActivity({
    runId: task.id,
    sessionId: task.sessionId,
    agentId,
    agentName: agents.find((agent) => agent.id === agentId)?.name,
    state,
    activity: task.problem?.message || (terminal
      ? task.status === "completed" ? "任务完成，准备休息" : "任务已停止"
      : task.message?.slice(0, 80) || "已在专属工位处理任务"),
    timestamp: task.completedAt ?? task.startedAt ?? task.createdAt ?? Date.now(),
  })
}

export function playCompletionTone(): void {
  try {
    const AudioContextClass = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    const context = new AudioContextClass()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.setValueAtTime(660, context.currentTime)
    oscillator.frequency.linearRampToValueAtTime(880, context.currentTime + 0.12)
    gain.gain.setValueAtTime(0.04, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.24)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.24)
  } catch {
    // 自动播放受限时保持静默
  }
}
