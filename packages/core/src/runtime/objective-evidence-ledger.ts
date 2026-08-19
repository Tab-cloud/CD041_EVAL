import type {
  ObjectiveAcceptancePolicy,
  ObjectiveEvidenceKind,
} from "./objective-compiler.ts"
import {
  evidenceTargetsCoverPatterns,
  normalizeEvidenceTarget,
} from "./evidence-targets.ts"
import type {
  ExecutionTodo,
  ObjectiveRequirementEvidenceBinding,
  ToolExecutionOutcome,
} from "./agent-loop-control.ts"
import { isRecord } from "./agent-loop-control-normalization.ts"

const OBJECTIVE_EVIDENCE_KINDS = new Set<ObjectiveEvidenceKind>([
  "plan-submission",
  "build-success",
  "test-success",
  "regression-test-success",
  "stress-test-success",
  "schematic-inspection",
  "datasheet-inspection",
  "source-inspection",
  "workspace-inspection",
  "external-research",
  "workspace-mutation",
  "process-verification",
  "hardware-observation",
])

export function summarizeEvidence(outcome: ToolExecutionOutcome): string {
  const summary = outcome.result.outcome?.summary
  const targets = [...new Set([
    ...outcome.semantics.mutationTargets,
    ...outcome.semantics.verificationTargets,
  ])]
  const targetSuffix = targets.length > 0 ? ` [${targets.join(", ")}]` : ""
  return `${outcome.name}: ${summary || "执行成功"}${targetSuffix}`.slice(0, 2_000)
}

export function isMaterialOutcome(outcome: ToolExecutionOutcome): boolean {
  return outcome.semantics.mutation
}

export function isVerificationOutcome(outcome: ToolExecutionOutcome): boolean {
  return outcome.semantics.verification
}

export function objectiveAcceptanceSatisfied(
  policy: ObjectiveAcceptancePolicy | undefined,
  bindings: ObjectiveRequirementEvidenceBinding[] | undefined,
): boolean {
  if (!policy || policy.requirements.length === 0) return false
  return policy.requirements.every((requirement) =>
    requirementSatisfied(requirement, bindings ?? []))
}

export function requirementSatisfied(
  requirement: ObjectiveAcceptancePolicy["requirements"][number],
  bindings: ObjectiveRequirementEvidenceBinding[],
): boolean {
  const targetPatterns = requirement.targetPatterns ?? []
  return bindings.some((binding) =>
    binding.requirementId === requirement.id
    && requirement.anyOf.includes(binding.kind)
    && evidenceTargetsCoverPatterns(
      binding.targets,
      targetPatterns,
      binding.globalVerification,
    ))
}

export function bindObjectiveEvidenceToRequirements(
  policy: ObjectiveAcceptancePolicy | undefined,
  outcome: ToolExecutionOutcome,
): ObjectiveRequirementEvidenceBinding[] {
  if (!policy || !outcome.result.success) return []
  const source = outcome.executionId ?? outcome.name
  return policy.requirements.flatMap((requirement) =>
    trustedObjectiveEvidence(outcome).flatMap((evidence) => {
      if (!requirement.anyOf.includes(evidence.kind)) return []
      if (!evidenceTargetsCoverPatterns(
        evidence.targets,
        requirement.targetPatterns ?? [],
        evidence.globalVerification,
      )) return []
      return [{
        requirementId: requirement.id,
        kind: evidence.kind,
        targets: evidence.targets,
        globalVerification: evidence.globalVerification,
        source,
      }]
    }))
}

/**
 * Attachment parsing happens at the trusted request boundary before the model
 * loop starts. A successfully extracted text attachment is therefore durable
 * inspection evidence for that exact resource, not an unverified model claim.
 */
export function bindAttachmentEvidenceToRequirements(
  policy: ObjectiveAcceptancePolicy | undefined,
  attachments: Array<{
    name: string
    kind: "image" | "text" | "binary"
    content?: string
  }> | undefined,
): ObjectiveRequirementEvidenceBinding[] {
  if (!policy || !Array.isArray(attachments)) return []
  return attachments.flatMap((attachment) => {
    if (attachment.kind !== "text" || typeof attachment.content !== "string"
      || !hasExtractedAttachmentContent(attachment.content)) return []
    const target = normalizeEvidenceTarget(attachment.name)
    if (!target) return []
    const kinds: ObjectiveEvidenceKind[] = ["workspace-inspection"]
    if (isSourceTarget(target)) kinds.push("source-inspection")
    return policy.requirements.flatMap((requirement) =>
      kinds.flatMap((kind) => {
        if (!requirement.anyOf.includes(kind)
          || !evidenceTargetsCoverPatterns(
            [target],
            requirement.targetPatterns ?? [],
            false,
          )) return []
        return [{
          requirementId: requirement.id,
          kind,
          targets: [target],
          globalVerification: false,
          source: `attachment:${target}`,
        }]
      }))
  })
}

function trustedObjectiveEvidence(outcome: ToolExecutionOutcome): Array<{
  kind: ObjectiveEvidenceKind
  targets: string[]
  globalVerification: boolean
}> {
  if (!outcome.result.success) return []
  const evidence: Array<{
    kind: ObjectiveEvidenceKind
    targets: string[]
    globalVerification: boolean
  }> = []
  const add = (
    kind: ObjectiveEvidenceKind,
    targets: readonly string[],
    globalVerification = false,
  ) => {
    const normalizedTargets = [...new Set(
      targets.map(normalizeEvidenceTarget).filter(Boolean),
    )]
    if (evidence.some((item) =>
      item.kind === kind
      && item.globalVerification === globalVerification
      && item.targets.join("\n") === normalizedTargets.join("\n"))) return
    evidence.push({ kind, targets: normalizedTargets, globalVerification })
  }
  if (outcome.semantics.mutation) {
    add("workspace-mutation", outcome.semantics.mutationTargets)
  }
  if (outcome.semantics.verification
    && ![
      "read",
      "grep",
      "glob",
      "schematic_read",
      "datasheet_read",
      "websearch",
      "webfetch",
    ].includes(outcome.name)) {
    add(
      "process-verification",
      outcome.semantics.verificationTargets,
      outcome.semantics.globalVerification,
    )
  }
  if ((outcome.name === "compile" || outcome.name === "bash")
    && outcome.result.outcome?.category === "build"
    && outcome.result.outcome.status === "succeeded") {
    add(
      "build-success",
      outcome.semantics.verificationTargets,
      outcome.semantics.globalVerification,
    )
  }
  for (const attestation of outcome.result.outcome?.evidence ?? []) {
    add(
      attestation.kind,
      attestation.targets,
      outcome.semantics.globalVerification,
    )
  }
  if (outcome.name === "plan") add("plan-submission", [])
  if (outcome.name === "schematic_read") {
    add(
      "schematic-inspection",
      outcome.semantics.verificationTargets,
      outcome.semantics.globalVerification,
    )
  }
  if (outcome.name === "datasheet_read") {
    add(
      "datasheet-inspection",
      outcome.semantics.verificationTargets,
      outcome.semantics.globalVerification,
    )
  }
  if (outcome.name === "websearch" || outcome.name === "webfetch") {
    add(
      "external-research",
      outcome.semantics.verificationTargets,
      outcome.semantics.globalVerification,
    )
  }
  if (isTrustedHardwareObservation(outcome)) {
    add(
      "hardware-observation",
      outcome.semantics.verificationTargets,
      outcome.semantics.globalVerification,
    )
  }
  if (["read", "grep", "glob"].includes(outcome.name)) {
    add(
      "workspace-inspection",
      outcome.semantics.verificationTargets,
      outcome.semantics.globalVerification,
    )
    if (isSourceInspection(outcome)) {
      add(
        "source-inspection",
        outcome.semantics.verificationTargets,
        outcome.semantics.globalVerification,
      )
    }
  }
  return evidence
}

function hasExtractedAttachmentContent(content: string): boolean {
  const normalized = content.trim()
  if (normalized.length < 20) return false
  return !normalized.startsWith("[已接收 ")
}

function isSourceTarget(target: string): boolean {
  return /\.(?:c|h|cc|cpp|cxx|hpp|s|asm|ld|mk|rs|go|py|java|kt|swift|ts|tsx|js|jsx|vue|svelte)$/i
    .test(target)
}

/**
 * Hardware evidence is action-sensitive. A tool merely carrying the
 * `hardware` effect is not proof that hardware was observed: close/reset/send
 * and breakpoint mutation are control operations, while a verified flash or
 * returned device/register/serial observation is evidence.
 */
function isTrustedHardwareObservation(outcome: ToolExecutionOutcome): boolean {
  if (!Array.isArray(outcome.toolEffects) || !outcome.toolEffects.includes("hardware")) return false
  const action = typeof outcome.input?.action === "string" ? outcome.input.action : ""
  if (outcome.name === "usb_detect") return action === "list" || action === "hid-list"
  if (outcome.name === "serial_monitor") return true
  if (outcome.name === "serial_open") return action === "list" || action === "receive"
  if (outcome.name === "swd_debug") {
    if (action === "connect" || action === "regs" || action === "memory") return true
    return action === "breakpoints"
      && (!Array.isArray(outcome.input?.breakpoints) || outcome.input.breakpoints.length === 0)
  }
  if (outcome.name === "flash") {
    const data = isRecord(outcome.result.data) ? outcome.result.data : {}
    return data.verified === true
  }
  return false
}

function isSourceInspection(outcome: ToolExecutionOutcome): boolean {
  const serialized = JSON.stringify(outcome.input ?? {}).replace(/\\/g, "/").toLowerCase()
  return /(?:^|[/"'])(?:src|source|code|firmware|include|inc|lib)(?:[/"']|$)/.test(serialized)
    || /\.(?:c|h|cc|cpp|cxx|hpp|s|asm|ld|mk|rs|go|py|java|kt|swift|ts|tsx|js|jsx|vue|svelte)(?:["'\],}]|$)/.test(serialized)
}

export function acceptancePolicyLabel(policy: ObjectiveAcceptancePolicy): string {
  return `取得运行时验收证据：${policy.requirements.map((item) => item.label).join("；")}`
}

export function cloneAcceptancePolicy(
  policy: ObjectiveAcceptancePolicy | undefined,
): ObjectiveAcceptancePolicy | undefined {
  if (!policy) return undefined
  return {
    requirements: policy.requirements.map((item) => ({
      id: item.id,
      label: item.label,
      verifier: item.verifier,
      anyOf: [...item.anyOf],
      targetPatterns: [...new Set(
        (item.targetPatterns ?? []).map(normalizeEvidenceTarget).filter(Boolean),
      )],
    })),
  }
}

export function normalizeObjectiveEvidenceBindings(
  value: unknown,
): ObjectiveRequirementEvidenceBinding[] {
  if (!Array.isArray(value)) return []
  return mergeObjectiveEvidenceBindings([], value.flatMap((item) => {
    if (!isRecord(item)
      || typeof item.requirementId !== "string"
      || !item.requirementId.trim()
      || typeof item.kind !== "string"
      || !OBJECTIVE_EVIDENCE_KINDS.has(item.kind as ObjectiveEvidenceKind)
      || typeof item.source !== "string"
      || !item.source.trim()) return []
    return [{
      requirementId: item.requirementId.trim().slice(0, 200),
      kind: item.kind as ObjectiveEvidenceKind,
      targets: Array.isArray(item.targets)
        ? item.targets.filter((target): target is string => typeof target === "string")
          .map(normalizeEvidenceTarget).filter(Boolean).slice(0, 100)
        : [],
      globalVerification: item.globalVerification === true,
      source: item.source.trim().slice(0, 500),
    }]
  }))
}

export function mergeObjectiveEvidenceBindings(
  current: ObjectiveRequirementEvidenceBinding[],
  incoming: ObjectiveRequirementEvidenceBinding[],
): ObjectiveRequirementEvidenceBinding[] {
  const merged = new Map<string, ObjectiveRequirementEvidenceBinding>()
  for (const binding of [...current, ...incoming]) {
    const normalized = {
      ...binding,
      targets: [...new Set(binding.targets.map(normalizeEvidenceTarget).filter(Boolean))],
    }
    const key = [
      normalized.requirementId,
      normalized.kind,
      normalized.globalVerification ? "global" : "targeted",
      normalized.targets.join("\n"),
      normalized.source,
    ].join("\u0000")
    merged.set(key, normalized)
  }
  return [...merged.values()].slice(-500)
}

export function mutationTargets(outcome: ToolExecutionOutcome): string[] {
  return outcome.semantics.mutationTargets
}

export function verificationCovers(
  outcome: ToolExecutionOutcome,
  target: string,
): boolean {
  if (outcome.semantics.globalVerification) return true
  const candidates = outcome.semantics.verificationTargets
  if (target === "*") return false
  return candidates.some((candidate) =>
    candidate === target
    || candidate.startsWith(`${target}/`)
    || target.startsWith(`${candidate}/`))
}

export function attachTrustedEvidence(
  todos: ExecutionTodo[],
  outcome: ToolExecutionOutcome,
): void {
  const todo = todos.find((item) => item.status === "in_progress")
    ?? todos.find((item) => item.status === "pending")
    ?? todos.find((item) =>
      item.status === "completed" && (!item.evidence?.length || !item.acceptance))
  if (!todo) return
  const summary = outcome.result.outcome?.summary || "执行成功"
  const reference = `${outcome.executionId ?? outcome.name}: ${summary}`.slice(0, 2_000)
  todo.evidence = [...new Set([...(todo.evidence ?? []), reference])].slice(-20)
}
