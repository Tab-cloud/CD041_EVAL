export function appendDownloadLog(current: string[], line: string, limit = 200): string[] {
  if (current.at(-1) === line) return current
  return [...current.slice(-(Math.max(1, limit) - 1)), line]
}
