/**
 * Canonical target matching shared by the live execution gate and durable
 * TaskResult diagnostics. Evidence targets are runtime-issued paths; model
 * prose and labels never participate in this matcher.
 */
export function normalizeEvidenceTarget(value: string): string {
  return value.trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "")
    .toLowerCase()
}

export function evidenceTargetMatches(value: string, pattern: string): boolean {
  const normalizedValue = normalizeEvidenceTarget(value)
  const normalizedPattern = normalizeEvidenceTarget(pattern)
  if (!normalizedValue || !normalizedPattern) return false
  if (normalizedPattern === "workspace:**" || normalizedPattern === "**" || normalizedPattern === "*") {
    return true
  }
  const marker = "__DOUBLE_STAR__"
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, marker)
    .replace(/\*/g, "[^/]*")
    .replaceAll(marker, ".*")
  return new RegExp(`^(?:${escaped}|.*\\/${escaped})$`, "i").test(normalizedValue)
}

export function evidenceTargetsCoverPatterns(
  targets: readonly string[],
  patterns: readonly string[],
  globalVerification = false,
): boolean {
  if (patterns.length === 0 || globalVerification) return true
  const normalizedTargets = [...new Set(targets.map(normalizeEvidenceTarget).filter(Boolean))]
  return patterns.every((pattern) =>
    normalizedTargets.some((target) => evidenceTargetMatches(target, pattern)))
}
