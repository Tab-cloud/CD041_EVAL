export function isActiveRunStatus(status?: string): boolean {
  return Boolean(status && [
    "queued",
    "running",
    "cancelling",
    "waiting-approval",
    "waiting-delegation",
    "safety-quarantine",
  ].includes(status))
}
