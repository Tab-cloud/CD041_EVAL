export interface ExecutionBudgetPolicy {
  /** Absolute wall-clock budget for the complete root objective. */
  totalDurationMs: number
  /** Renewable wall-clock lease for one root execution window. */
  rootWindowMs: number
  /** Maximum number of root execution windows, including the initial one. */
  maxRootWindows: number
  /** Maximum lease granted to one delegated child invocation. */
  childLeaseMs: number
  /** Time that must remain available for parent recovery and acceptance. */
  parentReserveMs: number
  /** Do not start a child when it cannot receive a meaningful lease. */
  minimumChildLeaseMs: number
  /** Maximum consecutive execution segments allowed without durable progress. */
  maxStagnantSegments: number
  /** Maximum rejected attempts that may be revised for one logical task. */
  maxRevisions: number
  /** Maximum distinct recovery strategies retained or attempted per objective. */
  maxRecoveryStrategies: number
}

export interface DelegatedExecutionLease {
  deadline: number
  leaseMs: number
  parentReserveMs: number
  rootRemainingMs: number
}

export interface DelegatedWorkloadEstimate {
  /** Historical P90 for the same agent/tool class. */
  predictedP90Ms: number
  /** Reserved time for acceptance checks and evidence inspection. */
  verificationReserveMs: number
  acceptanceCount: number
  dependencyCount: number
  resourceCount: number
  priorRevisions: number
}

export const DEFAULT_EXECUTION_BUDGET_POLICY: ExecutionBudgetPolicy = {
  totalDurationMs: 2 * 60 * 60_000,
  rootWindowMs: 30 * 60_000,
  maxRootWindows: 4,
  childLeaseMs: 8 * 60_000,
  parentReserveMs: 5 * 60_000,
  minimumChildLeaseMs: 30_000,
  maxStagnantSegments: 4,
  maxRevisions: 6,
  maxRecoveryStrategies: 8,
}

export function normalizeExecutionBudgetPolicy(value: unknown): ExecutionBudgetPolicy {
  const input = value && typeof value === "object" ? value as Partial<ExecutionBudgetPolicy> : {}
  const totalDurationMs = boundedInteger(
    input.totalDurationMs,
    5 * 60_000,
    24 * 60 * 60_000,
    DEFAULT_EXECUTION_BUDGET_POLICY.totalDurationMs,
  )
  const rootWindowMs = boundedInteger(
    input.rootWindowMs,
    5 * 60_000,
    totalDurationMs,
    Math.min(DEFAULT_EXECUTION_BUDGET_POLICY.rootWindowMs, totalDurationMs),
  )
  const parentReserveMs = boundedInteger(input.parentReserveMs, 60_000, Math.floor(rootWindowMs / 2), Math.min(DEFAULT_EXECUTION_BUDGET_POLICY.parentReserveMs, Math.floor(rootWindowMs / 2)))
  const minimumChildLeaseMs = boundedInteger(input.minimumChildLeaseMs, 5_000, 5 * 60_000, DEFAULT_EXECUTION_BUDGET_POLICY.minimumChildLeaseMs)
  const maxChildLease = Math.max(minimumChildLeaseMs, rootWindowMs - parentReserveMs)
  const childLeaseMs = boundedInteger(input.childLeaseMs, minimumChildLeaseMs, maxChildLease, Math.min(DEFAULT_EXECUTION_BUDGET_POLICY.childLeaseMs, maxChildLease))
  return {
    totalDurationMs,
    rootWindowMs,
    maxRootWindows: boundedInteger(
      input.maxRootWindows,
      1,
      Math.max(1, Math.ceil(totalDurationMs / rootWindowMs)),
      Math.min(
        DEFAULT_EXECUTION_BUDGET_POLICY.maxRootWindows,
        Math.max(1, Math.ceil(totalDurationMs / rootWindowMs)),
      ),
    ),
    childLeaseMs,
    parentReserveMs,
    minimumChildLeaseMs,
    maxStagnantSegments: boundedInteger(
      input.maxStagnantSegments,
      0,
      20,
      DEFAULT_EXECUTION_BUDGET_POLICY.maxStagnantSegments,
    ),
    maxRevisions: boundedInteger(
      input.maxRevisions,
      0,
      50,
      DEFAULT_EXECUTION_BUDGET_POLICY.maxRevisions,
    ),
    maxRecoveryStrategies: boundedInteger(
      input.maxRecoveryStrategies,
      1,
      100,
      DEFAULT_EXECUTION_BUDGET_POLICY.maxRecoveryStrategies,
    ),
  }
}

export function allocateDelegatedExecutionLease(
  rootDeadline: number,
  policy: ExecutionBudgetPolicy,
  now = Date.now(),
  estimate?: Partial<DelegatedWorkloadEstimate>,
): DelegatedExecutionLease | null {
  const rootRemainingMs = Math.max(0, rootDeadline - now)
  const childAvailableMs = rootRemainingMs - policy.parentReserveMs
  if (childAvailableMs < policy.minimumChildLeaseMs) return null
  const predicted = estimate
    ? normalizedPrediction(estimate, policy)
    : policy.childLeaseMs
  const leaseMs = Math.min(Math.max(policy.minimumChildLeaseMs, predicted), policy.childLeaseMs, childAvailableMs)
  return {
    deadline: now + leaseMs,
    leaseMs,
    parentReserveMs: rootRemainingMs - leaseMs,
    rootRemainingMs,
  }
}

/** Initial child attempt plus the bounded number of main-Agent revisions. */
export function delegatedTaskAttemptLimit(
  policy: Pick<ExecutionBudgetPolicy, "maxRevisions">,
): number {
  return 1 + Math.max(0, Math.min(50, Math.floor(policy.maxRevisions)))
}

export function executionStartedAt(value: unknown, now = Date.now()): number {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return now
  return Math.min(now, Math.floor(timestamp))
}

function normalizedPrediction(
  estimate: Partial<DelegatedWorkloadEstimate>,
  policy: ExecutionBudgetPolicy,
): number {
  const p90 = finiteNonNegative(estimate.predictedP90Ms, policy.childLeaseMs)
  const verification = finiteNonNegative(
    estimate.verificationReserveMs,
    Math.min(60_000, Math.round(policy.childLeaseMs * 0.15)),
  )
  const structuralReserve = (
    boundedCount(estimate.acceptanceCount, 20) * 2_000
    + boundedCount(estimate.dependencyCount, 20) * 1_000
    + boundedCount(estimate.resourceCount, 100) * 500
    + boundedCount(estimate.priorRevisions, 10) * 5_000
  )
  return Math.round(p90 + verification + structuralReserve)
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : fallback
}

function boundedCount(value: unknown, maximum: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.floor(number))) : 0
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(number)))
}
