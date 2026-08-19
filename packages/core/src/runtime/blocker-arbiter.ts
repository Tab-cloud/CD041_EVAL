import type { ObjectiveEvidenceKind } from "./objective-compiler.ts"

/**
 * Evidence kinds that inherently require observation outside the Agent
 * runtime. Other evidence classes remain Agent-owned and cannot be converted
 * into a blocker by model-authored todo text.
 */
const EXTERNAL_EVIDENCE_KINDS = new Set<ObjectiveEvidenceKind>([
  "hardware-observation",
])

export interface ExecutionExternalBlocker {
  kind: "user-decision" | "permission" | "hardware" | "external-service"
  reason: string
  sourceTool: string
  fingerprint: string
  evidence: string[]
  createdAt: number
}

export function isExternalAcceptanceEvidence(
  kind: ObjectiveEvidenceKind | undefined,
): boolean {
  return Boolean(kind && EXTERNAL_EVIDENCE_KINDS.has(kind))
}

export function todoMayBlockObjective(
  blockedBy: ObjectiveEvidenceKind | undefined,
  unmetRequirementKinds: ReadonlySet<ObjectiveEvidenceKind>,
): boolean {
  return Boolean(
    blockedBy
    && isExternalAcceptanceEvidence(blockedBy)
    && unmetRequirementKinds.has(blockedBy),
  )
}

export function normalizeExternalBlocker(
  value: unknown,
): ExecutionExternalBlocker | undefined {
  if (!isRecord(value)
    || !isKind(value.kind)
    || typeof value.reason !== "string"
    || typeof value.sourceTool !== "string"
    || typeof value.fingerprint !== "string") return
  return {
    kind: value.kind,
    reason: value.reason.slice(0, 2_000),
    sourceTool: value.sourceTool.slice(0, 128),
    fingerprint: value.fingerprint.slice(0, 500),
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, 2_000)).slice(0, 20)
      : [],
    createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : Date.now(),
  }
}

function isKind(value: unknown): value is ExecutionExternalBlocker["kind"] {
  return value === "user-decision" || value === "permission"
    || value === "hardware" || value === "external-service"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
