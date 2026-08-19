export interface AgentProgressBounds {
  step: number
  maxSteps: number
}

export function normalizeAgentProgressBounds(stepValue: unknown, maxStepsValue: unknown): AgentProgressBounds {
  const step = Math.max(1, Math.trunc(Number(stepValue)) || 1)
  const maxSteps = Math.max(step, Math.trunc(Number(maxStepsValue)) || 1)
  return { step, maxSteps }
}
