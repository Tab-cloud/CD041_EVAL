export function detachTerminalSubscription(input: {
  sessionId: string
  taskId: string
  activeTasksBySession: Map<string, string>
  abortsBySession: Map<string, AbortController>
}): boolean {
  if (input.activeTasksBySession.get(input.sessionId) !== input.taskId) return false
  const abort = input.abortsBySession.get(input.sessionId)
  if (!abort || abort.signal.aborted) return false
  abort.abort()
  return true
}

export function shouldRestoreTerminalTask(input: {
  activeSessionId: string | null
  activeRunTaskId?: string
  terminalSessionId: string
  terminalTaskId: string
}): boolean {
  return input.activeSessionId === input.terminalSessionId
    && input.activeRunTaskId === input.terminalTaskId
}
