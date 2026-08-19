import { createHash } from "node:crypto"
import type { ToolEffect, ToolResult } from "../tool/types.ts"
import type {
  ObjectiveAcceptancePolicy,
  ObjectiveEvidenceKind,
  ObjectiveVerifier,
} from "./objective-compiler.ts"
import type { ToolExecutionSemantics } from "./tool-execution-semantics.ts"
import { executionControlPolicy } from "./execution-control-policy.ts"
import {
  DEFAULT_EXECUTION_BUDGET_POLICY,
  executionStartedAt,
  type ExecutionBudgetPolicy,
} from "./execution-budget.ts"
import {
  isRecord,
  normalizeExecutionFollowups,
  normalizeExecutionTodos,
} from "./agent-loop-control-normalization.ts"
import {
  cloneRecoveryDirective,
  normalizeRecoveryDirective,
  recoveryActionSatisfied,
} from "./agent-loop-recovery.ts"
import { resolveToolFailureControl } from "./tool-failure-policy.ts"
import {
  cloneRecoveryLedger,
  hasAvailableRecoveryStrategy,
  mergeRecoveryStrategies,
  nextRecoveryStrategy,
  normalizeRecoveryLedger,
  planRecoveryStrategies,
  updateRecoveryStrategy,
  type RecoveryStrategyLedger,
} from "./recovery-planner.ts"
import {
  normalizeExternalBlocker,
  todoMayBlockObjective,
  type ExecutionExternalBlocker,
} from "./blocker-arbiter.ts"
import {
  acceptancePolicyLabel,
  attachTrustedEvidence,
  bindObjectiveEvidenceToRequirements,
  cloneAcceptancePolicy,
  isMaterialOutcome,
  isVerificationOutcome,
  mergeObjectiveEvidenceBindings,
  mutationTargets,
  normalizeObjectiveEvidenceBindings,
  objectiveAcceptanceSatisfied,
  requirementSatisfied,
  summarizeEvidence,
  verificationCovers,
} from "./objective-evidence-ledger.ts"

export {
  normalizeExecutionFollowups,
  normalizeExecutionTodos,
} from "./agent-loop-control-normalization.ts"

export interface ToolExecutionOutcome {
  name: string
  result: ToolResult
  input?: Record<string, unknown>
  executionId?: string
  /** Immutable capabilities of the tool definition that actually executed. */
  toolEffects: readonly ToolEffect[]
  semantics: ToolExecutionSemantics
}

export interface ToolObservationContext {
  /** Progress revision captured before the tool batch started. */
  progressRevisionBefore?: number
}

export type ExecutionPhase = "execution" | "finalization"
export type ExecutionStopReason = "budget-exhausted" | "stalled" | "time-limit"
export type ExecutionLifecycleState =
  | "running"
  | "waiting-approval"
  | "blocked"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
export type ExecutionTodoStatus = "pending" | "in_progress" | "paused" | "blocked" | "completed"

export interface ExecutionTodo {
  content: string
  status: ExecutionTodoStatus
  priority: "high" | "medium" | "low"
  acceptance?: string
  evidence?: string[]
  assignee?: string
  /** Required runtime evidence that is genuinely blocked by an external condition. */
  blockedBy?: ObjectiveEvidenceKind
}

export interface ExecutionFollowup {
  content: string
  owner: "user"
  category: "hardware-validation" | "external-action"
  reason?: string
}

/**
 * Runtime-issued evidence bound to one immutable acceptance requirement.
 *
 * A flat set of evidence kinds is insufficient: `read README.md` and
 * `read src/main.c` are both source/workspace inspection, but only one may
 * cover a target-specific criterion. These bindings are the authoritative
 * completion ledger and are persisted in the execution snapshot.
 */
export interface ObjectiveRequirementEvidenceBinding {
  requirementId: string
  kind: ObjectiveEvidenceKind
  targets: string[]
  globalVerification: boolean
  source: string
}

/**
 * Runtime-owned recovery contract created from a failed tool result.
 *
 * A diagnostic is execution state, not merely prose for the next model. It
 * survives model/provider retries and session continuation until the original
 * operation succeeds or a newer failure replaces it.
 */
export interface ExecutionRecoveryDirective {
  strategyId: string
  fingerprint: string
  sourceTool: string
  kind: string
  summary: string
  evidence: string[]
  actions: string[]
  /** Runtime-authored tool/effect contract for each action; never inferred from action prose. */
  actionTools?: string[][]
  actionEffects?: ToolEffect[][]
  actionIndex: number
  attempts: number
  updatedAt: number
}

export interface ExecutionSnapshot {
  state: ExecutionLifecycleState
  todos: ExecutionTodo[]
  /** Recommended manual work outside the Agent-owned acceptance graph. */
  followups?: ExecutionFollowup[]
  segment: number
  idleTurns: number
  toolRounds: number
  limit: number
  consecutiveNoProgress: number
  /** Number of runtime-owned execution segments used for the same objective. */
  continuations?: number
  /** Absolute beginning of the root objective budget, persisted across windows. */
  rootStartedAt?: number
  /** Number of renewable wall-clock windows already opened for this objective. */
  rootWindowsUsed?: number
  /** Monotonic revision advanced only by durable evidence or todo progress. */
  progressRevision?: number
  /** Progress revision captured when the current execution segment started. */
  segmentStartProgressRevision?: number
  /** Consecutive completed execution segments that produced no progress revision. */
  stagnantSegments?: number
  stopReason?: string
  lastEvidence?: string[]
  /**
   * Durable identities of objective-relevant tool observations.
   *
   * Execution ids are deliberately excluded: replaying the same successful
   * read/write/build is not progress unless its input or trusted result
   * changed. This ledger prevents a successful no-op loop from renewing its
   * own execution budget.
   */
  progressFingerprints?: string[]
  lastMutationRound?: number
  lastVerificationRound?: number
  pendingMutationTargets?: string[]
  /** Runtime-owned objective identity used for evidence-driven completion. */
  runtimeObjectiveContent?: string
  /** Version of the runtime-owned objective and acceptance contract. */
  objectiveContractFingerprint?: string
  /** Todos originating in the durable user objective, never from model planning. */
  runtimeTodoContents?: string[]
  /** Immutable commands that own resources required by this objective. */
  resourceRequestIds?: string[]
  /** Version of the semantic continuation/objective composition contract. */
  continuationContractVersion?: number
  /** Runtime-owned policy; model-authored todos cannot weaken or remove it. */
  objectiveAcceptancePolicy?: ObjectiveAcceptancePolicy
  /** Evidence classes derived only from successful tool results. */
  objectiveEvidenceKinds?: ObjectiveEvidenceKind[]
  /** Authoritative, target-bound evidence ledger for runtime acceptance. */
  objectiveEvidenceBindings?: ObjectiveRequirementEvidenceBinding[]
  runtimeObjectiveAccepted?: boolean
  /** Exact durable conversation objective revision that owns this execution graph. */
  conversationObjectiveId?: string
  conversationObjectiveFingerprint?: string
  /** Active autonomous recovery owned by the runtime control plane. */
  activeRecovery?: ExecutionRecoveryDirective
  /** Durable history of attempted, active and exhausted recovery strategies. */
  recoveryLedger?: RecoveryStrategyLedger
  /** Failed calls keyed by tool, semantic input and progress revision. */
  failedInvocations?: string[]
  /** Runtime-proven dependency outside the Agent's authority. */
  externalBlocker?: ExecutionExternalBlocker
  updatedAt: number
}

export interface AgentLoopRound {
  phase: ExecutionPhase
  toolsEnabled: boolean
  progressStep: number
}

export interface ExecutionDecision {
  phase: ExecutionPhase
  limit: number
  stopReason?: ExecutionStopReason
}

export interface ExecutionOutstandingSummary {
  runnableTodos: number
  verificationGaps: number
  acceptanceGaps: number
  total: number
}

export type ModelYieldDecision = "continue" | "complete" | "blocked" | "finalize"

export interface ExecutionControllerOptions {
  initial?: Partial<ExecutionSnapshot>
  persist?: (snapshot: ExecutionSnapshot) => void
  /** Runtime-owned hard safety policy. Models cannot raise these limits. */
  budgetPolicy?: ExecutionBudgetPolicy
  /** Concrete tasks projected from the durable conversation objective. */
  initialTodos?: ExecutionTodo[]
  /** Seeded by the runtime for operational requests; completion cannot depend on the model creating its own todo list. */
  objective?: {
    content: string
    acceptance: string
    acceptancePolicy?: ObjectiveAcceptancePolicy
    conversationObjectiveId?: string
    conversationObjectiveFingerprint?: string
  }
}

const TERMINAL_STATES = new Set<ExecutionLifecycleState>(["completed", "failed", "cancelled", "interrupted"])
const RUNNABLE_TODO_STATES = new Set<ExecutionTodoStatus>(["pending", "in_progress"])

/**
 * Open a new execution segment for an explicitly resumed objective.
 *
 * A stopped segment stores its active todo as paused/blocked. Merely changing
 * the root state to `running` leaves the todo graph non-runnable and causes the
 * next model yield to block immediately. Resume is therefore an atomic state
 * transition over both the run and its work graph.
 */
export function resumeExecutionSnapshot(snapshot: ExecutionSnapshot | undefined): ExecutionSnapshot | undefined {
  if (!snapshot || snapshot.state === "completed" || snapshot.state === "cancelled") return undefined

  const now = Date.now()
  let activated = false
  const todos = snapshot.todos.map((todo) => {
    if (todo.status !== "paused" && todo.status !== "blocked") return { ...todo }
    if (!activated) {
      activated = true
      return { ...todo, status: "in_progress" as const, blockedBy: undefined }
    }
    return { ...todo, status: "pending" as const, blockedBy: undefined }
  })

  return {
    ...snapshot,
    state: "running",
    todos,
    segment: snapshot.segment + 1,
    idleTurns: 0,
    toolRounds: 0,
    consecutiveNoProgress: 0,
    rootStartedAt: now,
    rootWindowsUsed: 1,
    stopReason: undefined,
    updatedAt: now,
  }
}

/**
 * Durable semantic execution control plane.
 *
 * The model may propose actions, but it cannot declare a run complete while
 * runnable work remains. Tool/test evidence controls verification and bounded
 * continuation; delegated results are returned to the main Agent as tool data.
 */
export class ExecutionController {
  private windowStartedAt = Date.now()
  private interactionWaitStartedAt?: number
  private readonly failureCounts = new Map<string, number>()
  private readonly persist?: (snapshot: ExecutionSnapshot) => void
  private phase: ExecutionPhase = "execution"
  private stopReason?: ExecutionStopReason
  private lastFailureSummary = ""
  private lastDiagnosticActions: string[] = []
  private value: ExecutionSnapshot
  private readonly budgetPolicy: ExecutionBudgetPolicy

  constructor(
    private readonly baseLimit: number,
    private readonly hardLimit = 50,
    private readonly maxDurationMs = 12 * 60_000,
    private readonly repeatedFailureLimit = 3,
    options: ExecutionControllerOptions = {},
  ) {
    const initial = options.initial
    const now = Date.now()
    this.budgetPolicy = {
      ...DEFAULT_EXECUTION_BUDGET_POLICY,
      ...options.budgetPolicy,
    }
    const currentContractFingerprint = options.objective
      ? executionContractFingerprint(options.objective.content, options.objective.acceptancePolicy)
      : initial?.objectiveContractFingerprint
    const contractChanged = Boolean(
      options.objective
      && initial
      && initial.objectiveContractFingerprint !== currentContractFingerprint,
    )
    // A snapshot is progress under one immutable objective contract. When a
    // newer runtime/compiler produces a different contract, old model plans,
    // blockers and counters cannot be resumed as authoritative work.
    const inherited = contractChanged ? undefined : initial
    const state = inherited?.state && !TERMINAL_STATES.has(inherited.state)
      ? "running"
      : inherited?.state ?? "running"
    const objectiveAcceptancePolicy = cloneAcceptancePolicy(
      options.objective?.acceptancePolicy ?? inherited?.objectiveAcceptancePolicy,
    )
    const objectiveEvidenceBindings = normalizeObjectiveEvidenceBindings(
      initial?.objectiveEvidenceBindings,
    )
    const runtimeObjectiveContent = options.objective?.content.slice(0, 2_000)
      ?? inherited?.runtimeObjectiveContent
    const runtimeTodoContents = [...new Set([
      ...(inherited?.runtimeTodoContents
        ?? options.initialTodos?.map((todo) => todo.content)
        ?? []),
      ...(runtimeObjectiveContent ? [runtimeObjectiveContent] : []),
    ].filter(Boolean))].slice(0, 100)
    this.value = {
      state,
      todos: normalizeExecutionTodos(inherited?.todos ?? options.initialTodos),
      followups: normalizeExecutionFollowups(inherited?.followups),
      segment: Math.max(0, inherited?.segment ?? 0),
      idleTurns: Math.max(0, inherited?.idleTurns ?? 0),
      toolRounds: Math.max(0, inherited?.toolRounds ?? 0),
      limit: Math.max(1, Math.min(hardLimit, inherited?.limit ?? baseLimit)),
      consecutiveNoProgress: Math.max(0, inherited?.consecutiveNoProgress ?? 0),
      continuations: Math.max(0, inherited?.continuations ?? 0),
      // Contract migration may rebuild the work graph, but it cannot mint a
      // fresh absolute safety budget.
      rootStartedAt: executionStartedAt(initial?.rootStartedAt, now),
      rootWindowsUsed: Math.max(1, Math.floor(initial?.rootWindowsUsed ?? 1)),
      progressRevision: Math.max(0, inherited?.progressRevision ?? 0),
      segmentStartProgressRevision: Math.max(
        0,
        inherited?.segmentStartProgressRevision ?? inherited?.progressRevision ?? 0,
      ),
      stagnantSegments: Math.max(0, inherited?.stagnantSegments ?? 0),
      stopReason: inherited?.stopReason,
      lastEvidence: inherited?.lastEvidence?.slice(0, 20),
      progressFingerprints: inherited?.progressFingerprints?.slice(-500),
      lastMutationRound: inherited?.lastMutationRound,
      lastVerificationRound: inherited?.lastVerificationRound,
      pendingMutationTargets: inherited?.pendingMutationTargets?.slice(0, 100) ?? [],
      runtimeObjectiveContent,
      objectiveContractFingerprint: currentContractFingerprint,
      runtimeTodoContents,
      resourceRequestIds: initial?.resourceRequestIds
        ?.filter((value): value is string => typeof value === "string" && Boolean(value))
        .slice(0, 20) ?? [],
      continuationContractVersion: Number.isInteger(initial?.continuationContractVersion)
        ? Math.max(1, Number(initial?.continuationContractVersion))
        : undefined,
      objectiveAcceptancePolicy,
      objectiveEvidenceKinds: [...new Set(objectiveEvidenceBindings.map((item) => item.kind))],
      objectiveEvidenceBindings,
      // Persisted completion is a projection of the target-bound ledger, not
      // an independently trusted boolean.
      runtimeObjectiveAccepted: objectiveAcceptanceSatisfied(
        objectiveAcceptancePolicy,
        objectiveEvidenceBindings,
      ),
      conversationObjectiveId: options.objective?.conversationObjectiveId ?? inherited?.conversationObjectiveId,
      conversationObjectiveFingerprint: options.objective?.conversationObjectiveFingerprint
        ?? inherited?.conversationObjectiveFingerprint,
      activeRecovery: normalizeRecoveryDirective(inherited?.activeRecovery),
      recoveryLedger: normalizeRecoveryLedger(inherited?.recoveryLedger),
      failedInvocations: inherited?.failedInvocations
        ?.filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, 2_000)).slice(-200) ?? [],
      externalBlocker: normalizeExternalBlocker(inherited?.externalBlocker),
      updatedAt: Date.now(),
    }
    this.demoteNonBlockingTodos()
    if (this.value.todos.length === 0 && options.objective) {
      this.value.todos = [{
        content: options.objective.content.slice(0, 2_000),
        status: "in_progress",
        priority: "high",
        acceptance: options.objective.acceptance.slice(0, 2_000),
      }]
    }
    this.ensureRuntimeObjectiveTodo()
    this.persist = options.persist
    this.commit()
  }

  snapshot(): ExecutionSnapshot {
    return {
      ...this.value,
      todos: this.value.todos.map((todo) => ({ ...todo, evidence: todo.evidence ? [...todo.evidence] : undefined })),
      followups: this.value.followups?.map((followup) => ({ ...followup })),
      runtimeTodoContents: this.value.runtimeTodoContents
        ? [...this.value.runtimeTodoContents]
        : undefined,
      resourceRequestIds: this.value.resourceRequestIds
        ? [...this.value.resourceRequestIds]
        : undefined,
      lastEvidence: this.value.lastEvidence ? [...this.value.lastEvidence] : undefined,
      progressFingerprints: this.value.progressFingerprints
        ? [...this.value.progressFingerprints]
        : undefined,
      objectiveAcceptancePolicy: cloneAcceptancePolicy(this.value.objectiveAcceptancePolicy),
      objectiveEvidenceKinds: this.value.objectiveEvidenceKinds
        ? [...this.value.objectiveEvidenceKinds]
        : undefined,
      objectiveEvidenceBindings: this.value.objectiveEvidenceBindings
        ?.map((binding) => ({ ...binding, targets: [...binding.targets] })),
      activeRecovery: cloneRecoveryDirective(this.value.activeRecovery),
      recoveryLedger: cloneRecoveryLedger(this.value.recoveryLedger),
      failedInvocations: this.value.failedInvocations
        ? [...this.value.failedInvocations]
        : undefined,
      externalBlocker: this.value.externalBlocker
        ? { ...this.value.externalBlocker, evidence: [...this.value.externalBlocker.evidence] }
        : undefined,
    }
  }

  currentRound(): AgentLoopRound {
    return {
      phase: this.phase,
      toolsEnabled: this.phase === "execution",
      progressStep: Math.min(this.value.toolRounds + 1, this.value.limit),
    }
  }

  currentLimit(): number { return this.value.limit }
  runnableTodoCount(): number {
    const todos = this.value.runtimeObjectiveAccepted ? this.authoritativeTodos() : this.value.todos
    return todos.filter((todo) => RUNNABLE_TODO_STATES.has(todo.status)).length
  }
  hasRunnableTodos(): boolean { return this.runnableTodoCount() > 0 }
  nextRunnableTodo(): ExecutionTodo | undefined {
    const aggregate = this.value.runtimeObjectiveContent
    return this.value.todos.find((todo) => todo.status === "in_progress" && todo.content !== aggregate)
      ?? this.value.todos.find((todo) => todo.status === "pending" && todo.content !== aggregate)
      ?? this.value.todos.find((todo) => todo.status === "in_progress")
      ?? this.value.todos.find((todo) => todo.status === "pending")
  }
  currentRecovery(): ExecutionRecoveryDirective | undefined {
    return cloneRecoveryDirective(this.value.activeRecovery)
  }
  outstandingAcceptanceVerifiers(): ObjectiveVerifier[] {
    const policy = this.value.objectiveAcceptancePolicy
    if (!policy) return []
    return [...new Set(policy.requirements
      .filter((requirement) => !requirementSatisfied(
        requirement,
        this.value.objectiveEvidenceBindings ?? [],
      ))
      .map((requirement) => requirement.verifier))]
  }
  hasFailedInvocation(name: string, input: Record<string, unknown>): boolean {
    return (this.value.failedInvocations ?? [])
      .includes(invocationSignature(name, input, this.value.progressRevision ?? 0))
  }
  needsVerification(): boolean {
    return (this.value.pendingMutationTargets?.length ?? 0) > 0 || (this.value.lastMutationRound !== undefined
      && (this.value.lastVerificationRound ?? -1) < this.value.lastMutationRound)
  }
  hasAcceptanceGaps(): boolean {
    return this.authoritativeTodos()
      .some((todo) => todo.status === "completed" && (!todo.acceptance || !todo.evidence?.length))
  }
  outstandingWorkCount(): number {
    return this.outstandingWorkSummary().total
  }
  outstandingWorkSummary(): ExecutionOutstandingSummary {
    const runnableTodos = this.runnableTodoCount()
    const verificationGaps = executionControlPolicy.verificationGapIsBlocking({
      hasAcceptancePolicy: Boolean(this.value.objectiveAcceptancePolicy),
      objectiveAccepted: Boolean(this.value.runtimeObjectiveAccepted),
      mutationVerificationPending: this.needsVerification(),
    }) ? 1 : 0
    const acceptanceGaps = this.hasAcceptanceGaps() ? 1 : 0
    return {
      runnableTodos,
      verificationGaps,
      acceptanceGaps,
      total: runnableTodos + verificationGaps + acceptanceGaps,
    }
  }

  /**
   * A safety boundary ends one model segment, not the user's objective. The
   * runtime may open another bounded segment while keeping the same deadline,
   * todo graph and evidence ledger.
   */
  canContinueAfterBoundary(maxStagnantSegments = 3): boolean {
    void maxStagnantSegments
    const boundaryCanAdvance = this.stopReason === "budget-exhausted"
      || this.stopReason === "stalled"
    return this.phase === "finalization"
      && this.stopReason !== "time-limit"
      && boundaryCanAdvance
      && this.hasContinuableWork()
  }

  /**
   * Root wall-clock windows are renewable leases, not objective deadlines.
   * A live objective may renew only while executable or unverified work
   * remains. Delegated children keep their fixed parent-issued deadline.
   */
  canRenewTimeWindow(): boolean {
    return this.phase === "finalization"
      && this.stopReason === "time-limit"
      && this.hasContinuableWork()
  }

  renewTimeWindow(): ExecutionSnapshot {
    if (!this.canRenewTimeWindow()) return this.snapshot()
    this.phase = "execution"
    this.stopReason = undefined
    this.windowStartedAt = Date.now()
    this.failureCounts.clear()
    this.value.state = "running"
    this.value.segment += 1
    this.value.continuations = (this.value.continuations ?? 0) + 1
    this.value.rootWindowsUsed = (this.value.rootWindowsUsed ?? 1) + 1
    this.rollSegmentProgress()
    this.value.idleTurns = 0
    this.value.toolRounds = 0
    this.value.limit = Math.max(1, Math.min(this.hardLimit, this.baseLimit))
    this.value.stopReason = undefined
    this.commit()
    return this.snapshot()
  }

  continueAfterBoundary(): ExecutionSnapshot {
    if (!this.canContinueAfterBoundary(this.budgetPolicy.maxStagnantSegments)) return this.snapshot()
    this.phase = "execution"
    this.stopReason = undefined
    this.failureCounts.clear()
    this.value.state = "running"
    this.value.segment += 1
    this.value.continuations = (this.value.continuations ?? 0) + 1
    this.rollSegmentProgress()
    this.value.idleTurns = 0
    this.value.toolRounds = 0
    this.value.limit = Math.max(1, Math.min(this.hardLimit, this.baseLimit))
    this.value.consecutiveNoProgress = 0
    this.value.stopReason = undefined
    this.commit()
    return this.snapshot()
  }

  /**
   * Re-open the same root execution for an explicit user steer.
   *
   * Guidance may refine the objective, but it never changes scope, tool
   * policy, resource claims, or approval requirements. It adds runtime-owned
   * work and opens a fresh execution segment while preserving the existing
   * evidence ledger and absolute ownership lineage.
   */
  acceptUserGuidance(values: string[]): ExecutionSnapshot {
    const guidance = [...new Set(values
      .map((value) => value.trim())
      .filter(Boolean))]
      .slice(0, 20)
    if (guidance.length === 0) return this.snapshot()

    this.phase = "execution"
    this.stopReason = undefined
    this.failureCounts.clear()
    this.windowStartedAt = Date.now()
    this.value.state = "running"
    this.value.segment += 1
    this.value.continuations = (this.value.continuations ?? 0) + 1
    this.value.rootWindowsUsed = (this.value.rootWindowsUsed ?? 1) + 1
    this.rollSegmentProgress()
    this.value.idleTurns = 0
    this.value.toolRounds = 0
    this.value.limit = Math.max(1, Math.min(this.hardLimit, this.baseLimit))
    this.value.consecutiveNoProgress = 0
    this.value.stopReason = undefined

    const runtimeTodos = new Set(this.value.runtimeTodoContents ?? [])
    for (const content of guidance) runtimeTodos.add(content)
    this.value.runtimeTodoContents = [...runtimeTodos].slice(0, 100)
    for (const content of guidance) {
      const existing = this.value.todos.find((todo) => todo.content === content)
      if (existing) {
        existing.status = "in_progress"
        existing.blockedBy = undefined
        existing.acceptance ||= "满足用户在当前运行中追加的要求，并保留可追溯的执行结果"
        continue
      }
      this.value.todos.push({
        content,
        status: "in_progress",
        priority: "high",
        acceptance: "满足用户在当前运行中追加的要求，并保留可追溯的执行结果",
      })
    }
    this.commit()
    return this.snapshot()
  }

  updateTodos(value: unknown): ExecutionSnapshot {
    const previousOutstanding = this.outstandingWorkCount()
    const previousCompleted = this.value.todos.filter((todo) => todo.status === "completed").length
    const previous = new Map(this.value.todos.map((todo) => [todo.content, todo]))
    const runtimeTodos = new Set(this.value.runtimeTodoContents ?? [])
    const proposed: ExecutionTodo[] = normalizeExecutionTodos(value).map((todo) => {
      const trusted = previous.get(todo.content)
      const runtimeOwned = runtimeTodos.has(todo.content)
      const aggregateObjective = todo.content === this.value.runtimeObjectiveContent
      const status = runtimeOwned && this.value.objectiveAcceptancePolicy
        && !this.value.runtimeObjectiveAccepted && todo.status === "completed"
        && (aggregateObjective || !trusted?.evidence?.length)
        ? "in_progress"
        : todo.status
      return {
        ...todo,
        status,
        acceptance: todo.acceptance ?? trusted?.acceptance,
        evidence: trusted?.evidence ? [...trusted.evidence] : undefined,
        assignee: todo.assignee ?? trusted?.assignee,
      }
    })
    for (const content of [...runtimeTodos].reverse()) {
      if (proposed.some((todo) => todo.content === content)) continue
      const trusted = previous.get(content)
      proposed.unshift(trusted
        ? {
            ...trusted,
            status: content === this.value.runtimeObjectiveContent
              ? this.value.runtimeObjectiveAccepted ? "completed" : "in_progress"
              : trusted.status,
            evidence: trusted.evidence ? [...trusted.evidence] : undefined,
          }
        : {
            content,
            status: content === this.value.runtimeObjectiveContent && this.value.runtimeObjectiveAccepted
              ? "completed"
              : "pending",
            priority: "high",
            acceptance: content === this.value.runtimeObjectiveContent
              && this.value.objectiveAcceptancePolicy
              ? acceptancePolicyLabel(this.value.objectiveAcceptancePolicy)
              : undefined,
          })
    }
    this.value.todos = proposed
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "followups")) {
      this.value.followups = normalizeExecutionFollowups(value.followups)
    }
    this.demoteNonBlockingTodos()
    this.value.idleTurns = 0
    this.value.stopReason = undefined
    const completed = this.value.todos.filter((todo) => todo.status === "completed").length
    if (completed > previousCompleted || this.outstandingWorkCount() < previousOutstanding) {
      this.markProgress()
    }
    if (this.value.state === "blocked" && this.hasRunnableTodos()) this.value.state = "running"
    this.commit()
    return this.snapshot()
  }

  /**
   * Model-authored todos cannot expand the runtime-owned acceptance contract.
   * An external condition blocks the root only when it names an evidence kind
   * that the current objective actually requires and has not yet satisfied.
   * Everything else is a user follow-up and stays outside completion counts.
   */
  private demoteNonBlockingTodos(): void {
    const policy = this.value.objectiveAcceptancePolicy
    if (!policy) return
    const blockingKinds = new Set(policy.requirements
      .filter((requirement) => !requirementSatisfied(
        requirement,
        this.value.objectiveEvidenceBindings ?? [],
      ))
      .flatMap((requirement) => requirement.anyOf))
    const retained: ExecutionTodo[] = []
    const followups = new Map((this.value.followups ?? []).map((item) => [item.content, item]))
    for (const todo of this.value.todos) {
      if (todo.status !== "blocked" || todoMayBlockObjective(todo.blockedBy, blockingKinds)) {
        retained.push(todo)
        continue
      }
      followups.set(todo.content, {
        content: todo.content,
        owner: "user",
        category: todo.blockedBy === "hardware-observation"
          ? "hardware-validation"
          : "external-action",
        reason: todo.acceptance,
      })
    }
    this.value.todos = retained
    this.value.followups = [...followups.values()].slice(0, 50)
  }

  private hasRuntimeAcceptanceBlocker(): boolean {
    const policy = this.value.objectiveAcceptancePolicy
    if (!policy) return false
    const unmet = new Set(policy.requirements
      .filter((requirement) => !requirementSatisfied(
        requirement,
        this.value.objectiveEvidenceBindings ?? [],
      ))
      .flatMap((requirement) => requirement.anyOf))
    return Boolean(
      this.value.externalBlocker
      && !this.value.activeRecovery
      && !hasAvailableRecoveryStrategy(this.value.recoveryLedger),
    )
      || this.value.todos.some((todo) =>
        todo.status === "blocked" && todoMayBlockObjective(todo.blockedBy, unmet))
  }

  checkTime(): ExecutionDecision {
    if (this.phase === "execution" && Date.now() - this.windowStartedAt > this.maxDurationMs) return this.finalize("time-limit")
    return { phase: this.phase, limit: this.value.limit, stopReason: this.stopReason }
  }

  observe(outcomes: ToolExecutionOutcome[], context: ToolObservationContext = {}): ExecutionDecision {
    if (this.phase !== "execution") return { phase: this.phase, limit: this.value.limit, stopReason: this.stopReason }
    this.value.toolRounds += 1
    this.value.idleTurns = 0
    const progressCommittedDuringBatch = context.progressRevisionBefore !== undefined
      && (this.value.progressRevision ?? 0) > context.progressRevisionBefore
    const previousProgressFingerprints = new Set(this.value.progressFingerprints ?? [])
    const previousPendingTargets = this.value.pendingMutationTargets?.length ?? 0
    const previousObjectiveEvidence = JSON.stringify(this.value.objectiveEvidenceBindings ?? [])
    const previousObjectiveAccepted = Boolean(this.value.runtimeObjectiveAccepted)
    const failure = outcomes.find((item) => !item.result.success)
    let recoveryAdvanced = false
    const evidence = outcomes.filter((item) => item.result.success).map((item) => summarizeEvidence(item)).filter(Boolean)
    const progressFingerprints = outcomes
      .filter((item) => item.result.success && outcomeCanAdvanceObjective(
        this.value.objectiveAcceptancePolicy,
        item,
      ))
      .map(progressFingerprint)
    outcomes.forEach((outcome, index) => {
      if (!outcome.result.success) return
      if (this.value.activeRecovery) {
        if (outcome.name === this.value.activeRecovery.sourceTool) {
          this.value.recoveryLedger = updateRecoveryStrategy(
            this.value.recoveryLedger,
            this.value.activeRecovery.strategyId,
            { status: "succeeded" },
          )
          this.value.activeRecovery = undefined
          if (this.value.externalBlocker?.sourceTool === outcome.name) {
            this.value.externalBlocker = undefined
          }
          recoveryAdvanced = true
        } else if (recoveryActionSatisfied(this.value.activeRecovery, outcome)) {
          const nextAction = this.value.activeRecovery.actionIndex + 1
          if (nextAction >= this.value.activeRecovery.actions.length) {
            this.value.recoveryLedger = updateRecoveryStrategy(
              this.value.recoveryLedger,
              this.value.activeRecovery.strategyId,
              { status: "succeeded" },
            )
            this.value.activeRecovery = undefined
          } else {
            this.value.activeRecovery.actionIndex = nextAction
            this.value.activeRecovery.updatedAt = Date.now()
            this.value.recoveryLedger = updateRecoveryStrategy(
              this.value.recoveryLedger,
              this.value.activeRecovery.strategyId,
              { actionIndex: nextAction },
            )
          }
          recoveryAdvanced = true
        }
      }
      this.value.objectiveEvidenceBindings = mergeObjectiveEvidenceBindings(
        this.value.objectiveEvidenceBindings ?? [],
        bindObjectiveEvidenceToRequirements(
          this.value.objectiveAcceptancePolicy,
          outcome,
        ),
      )
      this.value.objectiveEvidenceKinds = [...new Set(
        this.value.objectiveEvidenceBindings.map((item) => item.kind),
      )]
      if (!failure && objectiveAcceptanceSatisfied(
        this.value.objectiveAcceptancePolicy,
        this.value.objectiveEvidenceBindings,
      )) {
        this.value.runtimeObjectiveAccepted = true
        this.completeRuntimeObjective(outcome)
      }
      const sequence = this.value.segment * 100_000 + this.value.toolRounds * 1_000 + index
      if (isMaterialOutcome(outcome)) {
        this.value.lastMutationRound = sequence
        const targets = mutationTargets(outcome)
        this.value.pendingMutationTargets = [...new Set([...(this.value.pendingMutationTargets ?? []), ...(targets.length ? targets : ["*"])])].slice(0, 100)
      }
      if (isVerificationOutcome(outcome)) {
        const pending = this.value.pendingMutationTargets ?? []
        const covered = pending.filter((target) => verificationCovers(outcome, target))
        if (covered.length > 0 || pending.length === 0) this.value.lastVerificationRound = sequence
        this.value.pendingMutationTargets = pending.filter((target) => !covered.includes(target))
        attachTrustedEvidence(this.value.todos, outcome)
      }
    })

    const verification = outcomes.some((outcome) => outcome.result.success && outcome.semantics.verification)
    const material = outcomes.some((outcome) => outcome.result.success && outcome.semantics.mutation)
    const autoCompleted = !failure
      && !previousObjectiveAccepted
      && Boolean(this.value.runtimeObjectiveAccepted)
    if (autoCompleted) this.ensureRuntimeObjectiveTodo()
    const madeProgress = progressCommittedDuringBatch
      || autoCompleted
      || recoveryAdvanced
      || (!previousObjectiveAccepted && Boolean(this.value.runtimeObjectiveAccepted))
      || progressFingerprints.some((item) => !previousProgressFingerprints.has(item))
      || (this.value.pendingMutationTargets?.length ?? 0) < previousPendingTargets
      || JSON.stringify(this.value.objectiveEvidenceBindings ?? []) !== previousObjectiveEvidence
    if (evidence.length) {
      this.value.lastEvidence = [...new Set([...(this.value.lastEvidence ?? []), ...evidence])].slice(-20)
    }
    if (progressFingerprints.length) {
      this.value.progressFingerprints = [...new Set([
        ...(this.value.progressFingerprints ?? []),
        ...progressFingerprints,
      ])].slice(-500)
    }

    if (failure) {
      const failureControl = resolveToolFailureControl(failure.result)
      const fingerprint = failure.result.outcome?.fingerprint ?? `${failure.name}:${failure.result.error ?? "failed"}`
      const count = (this.failureCounts.get(fingerprint) ?? 0) + 1
      this.failureCounts.set(fingerprint, count)
      this.lastFailureSummary = failure.result.outcome?.summary ?? failure.result.error ?? "工具执行失败"
      this.lastDiagnosticActions = failure.result.outcome?.diagnostic?.nextActions ?? []
      const externalBlocker = failure.result.outcome?.diagnostic?.externalBlocker
      if (externalBlocker) {
        this.value.externalBlocker = {
          ...externalBlocker,
          sourceTool: failure.name,
          fingerprint,
          evidence: [...new Set(failure.result.outcome?.diagnostic?.evidence ?? [])].slice(0, 20),
          createdAt: Date.now(),
        }
      }
      this.failActiveRecovery()
      const recoveryCreated = failureControl.disposition === "recover"
        ? this.captureRecoveryDirective(failure, fingerprint)
        : false
      const recoveryAttempts = this.value.activeRecovery?.fingerprint === fingerprint
        ? this.value.activeRecovery.attempts
        : count
      if (madeProgress || recoveryCreated) {
        if (progressCommittedDuringBatch && !recoveryCreated) this.value.consecutiveNoProgress = 0
        else this.markProgress()
      } else this.value.consecutiveNoProgress += 1
      const failedInvocation = invocationSignature(
        failure.name,
        failure.input ?? {},
        this.value.progressRevision ?? 0,
      )
      this.value.failedInvocations = [...new Set([
        ...(this.value.failedInvocations ?? []),
        failedInvocation,
      ])].slice(-200)
      if (failureControl.disposition === "continue") {
        this.commit()
        return { phase: this.phase, limit: this.value.limit, stopReason: this.stopReason }
      }
      if (failureControl.disposition === "terminal") {
        this.value.activeRecovery = undefined
        this.commit()
        return this.finalize("stalled")
      }
      // Exhausting a suggested recovery set or repeating a failure retires the
      // exact invocation through failedInvocations; it does not terminate the
      // root objective. The next model turn receives the evidence and may use
      // any other authorized strategy.
      void recoveryAttempts
      if (count === 1 && failure.result.outcome?.diagnostic) this.extendLimit(2)
    } else {
      this.failureCounts.clear()
      if (madeProgress) {
        if (progressCommittedDuringBatch) this.value.consecutiveNoProgress = 0
        else this.markProgress()
        if (this.hasRunnableTodos() || material || verification) {
          this.extendLimit(verification ? 2 : 1)
        }
      } else {
        this.value.consecutiveNoProgress += 1
        if (executionControlPolicy.successfulToolStagnationIsTerminal({
          consecutiveNoProgress: this.value.consecutiveNoProgress,
        })) {
          return this.finalize("stalled")
        }
      }
    }
    this.commit()

    if (this.value.toolRounds >= this.value.limit || this.value.toolRounds >= this.hardLimit) return this.finalize("budget-exhausted")
    return { phase: this.phase, limit: this.value.limit }
  }

  onModelYield(): ModelYieldDecision {
    if (this.phase === "finalization") {
      return this.value.state === "completed" ? "complete" : "finalize"
    }
    if (this.value.state === "blocked" || this.value.state === "waiting-approval") return "blocked"
    if (this.value.state === "failed" || this.value.state === "cancelled"
      || this.value.state === "interrupted") return "finalize"

    // Model completion is the ordinary turn boundary. Todos, evidence and
    // verification gaps remain persisted for diagnostics and optional domain
    // checks, but cannot force another model turn or manufacture a failure.
    this.value.state = "completed"
    this.value.stopReason = undefined
    this.commit()
    return "complete"
  }

  waitForApproval(reason = "等待用户批准"): void {
    if (!this.interactionWaitStartedAt) this.interactionWaitStartedAt = Date.now()
    this.value.state = "waiting-approval"
    this.value.stopReason = reason
    this.commit()
  }

  resumeAfterApproval(): void {
    if (this.interactionWaitStartedAt) {
      const waitDuration = Math.max(0, Date.now() - this.interactionWaitStartedAt)
      this.windowStartedAt += waitDuration
      this.value.rootStartedAt = (this.value.rootStartedAt ?? Date.now()) + waitDuration
      this.interactionWaitStartedAt = undefined
    }
    this.value.state = "running"
    this.value.stopReason = undefined
    this.commit()
  }

  markBlocked(reason: string): void {
    this.value.state = "blocked"
    this.value.stopReason = reason
    this.commit()
  }

  interrupt(reason: string): void {
    this.value.state = "interrupted"
    this.value.stopReason = reason
    this.commit()
  }

  fail(reason: string): void {
    this.value.state = "failed"
    this.value.stopReason = reason
    this.commit()
  }

  finalize(reason: ExecutionStopReason): ExecutionDecision {
    this.phase = "finalization"
    this.stopReason = reason
    this.value.state = "finalizing"
    this.value.stopReason = reason
    this.commit()
    return { phase: this.phase, limit: this.value.limit, stopReason: reason }
  }

  finalizationInstructions(): string[] {
    const reason = this.value.state === "completed" && !this.stopReason
      ? "目标验收条件已由运行时证据满足"
      : this.stopReason === "stalled"
      ? "执行因相同问题反复出现或连续无有效进展而中断"
      : this.stopReason === "time-limit"
        ? "执行达到运行时长安全上限"
        : "执行已达到当前安全预算上限"
    return [
      reason,
      this.lastFailureSummary ? `最后确认的失败：${this.lastFailureSummary}` : "尚无足够证据确认全部目标完成",
      ...this.lastDiagnosticActions.map((action) => `建议下一步：${action}`),
    ]
  }

  private markProgress(): void {
    this.value.progressRevision = (this.value.progressRevision ?? 0) + 1
    this.value.consecutiveNoProgress = 0
  }

  private captureRecoveryDirective(
    failure: ToolExecutionOutcome,
    fingerprint: string,
  ): boolean {
    const diagnostic = failure.result.outcome?.diagnostic
    if (diagnostic?.retryable === false) return false
    const planned = planRecoveryStrategies(failure, fingerprint)
    this.value.recoveryLedger = mergeRecoveryStrategies(
      this.value.recoveryLedger,
      planned,
      this.budgetPolicy.maxRecoveryStrategies,
    )
    const strategy = nextRecoveryStrategy(this.value.recoveryLedger, fingerprint)
    if (!strategy) return false
    const attempts = strategy.attempts + 1
    this.value.recoveryLedger = updateRecoveryStrategy(
      this.value.recoveryLedger,
      strategy.id,
      { status: "active", attempts },
    )
    this.value.activeRecovery = {
      strategyId: strategy.id,
      fingerprint,
      sourceTool: failure.name,
      kind: diagnostic?.kind ?? failure.result.outcome?.category ?? "tool-failure",
      summary: failure.result.outcome?.summary ?? failure.result.error ?? "工具执行失败",
      evidence: [...strategy.evidence],
      actions: [...strategy.actions],
      actionTools: strategy.actionTools.map((tools) => [...tools]),
      actionEffects: strategy.actionEffects.map((effects) => [...effects]),
      actionIndex: strategy.actionIndex,
      attempts,
      updatedAt: Date.now(),
    }
    return true
  }

  private failActiveRecovery(): void {
    if (!this.value.activeRecovery) return
    this.value.recoveryLedger = updateRecoveryStrategy(
      this.value.recoveryLedger,
      this.value.activeRecovery.strategyId,
      { status: "failed" },
    )
    this.value.activeRecovery = undefined
  }

  private ensureRuntimeObjectiveTodo(): void {
    const content = this.value.runtimeObjectiveContent
    const policy = this.value.objectiveAcceptancePolicy
    if (!content || !policy) return
    this.value.runtimeTodoContents = [...new Set([
      ...(this.value.runtimeTodoContents ?? []),
      content,
    ])].slice(0, 100)
    const acceptedEvidence = this.value.runtimeObjectiveAccepted
      ? [...new Set((this.value.objectiveEvidenceBindings ?? [])
          .map((binding) => binding.source)
          .filter(Boolean))].slice(-20)
      : undefined
    const existing = this.value.todos.find((todo) => todo.content === content)
    if (existing) {
      existing.acceptance = acceptancePolicyLabel(policy)
      if (this.value.runtimeObjectiveAccepted) {
        existing.status = "completed"
        const existingEvidence = existing.evidence ?? []
        const newSources = (acceptedEvidence ?? []).filter((source) =>
          !existingEvidence.some((item) => item === source || item.startsWith(`${source}:`)))
        existing.evidence = [...new Set([
          ...existingEvidence,
          ...newSources,
        ])].slice(-20)
      }
      return
    }
    this.value.todos.unshift({
      content,
      status: this.value.runtimeObjectiveAccepted ? "completed" : "in_progress",
      priority: "high",
      acceptance: acceptancePolicyLabel(policy),
      evidence: acceptedEvidence,
    })
  }

  private completeRuntimeObjective(outcome: ToolExecutionOutcome): void {
    const content = this.value.runtimeObjectiveContent
    if (!content) return
    const todo = this.value.todos.find((item) => item.content === content)
    if (!todo) return
    const summary = outcome.result.outcome?.summary || "执行成功"
    const reference = `${outcome.executionId ?? outcome.name}: ${summary}`.slice(0, 2_000)
    todo.evidence = [...new Set([...(todo.evidence ?? []), reference])].slice(-20)
    todo.status = "completed"
  }

  private authoritativeTodos(): ExecutionTodo[] {
    const runtimeTodos = new Set(this.value.runtimeTodoContents ?? [])
    return runtimeTodos.size > 0
      ? this.value.todos.filter((todo) => runtimeTodos.has(todo.content))
      : this.value.todos
  }

  private nextStagnantSegmentCount(): number {
    const progressed = (this.value.progressRevision ?? 0) > (this.value.segmentStartProgressRevision ?? 0)
    return progressed ? 0 : (this.value.stagnantSegments ?? 0) + 1
  }

  private hasContinuableWork(): boolean {
    return this.outstandingWorkCount() > 0
      || this.value.toolRounds > 0
      || Boolean(this.value.activeRecovery)
      || hasAvailableRecoveryStrategy(this.value.recoveryLedger)
      || Boolean(this.lastFailureSummary)
  }

  private rollSegmentProgress(): void {
    this.value.stagnantSegments = this.nextStagnantSegmentCount()
    this.value.segmentStartProgressRevision = this.value.progressRevision ?? 0
  }

  private extendLimit(amount: number): void {
    this.value.limit = Math.min(this.hardLimit, this.value.limit + amount)
  }

  private commit(): void {
    this.value.updatedAt = Date.now()
    this.persist?.(this.snapshot())
  }
}

function executionContractFingerprint(
  content: string,
  policy: ObjectiveAcceptancePolicy | undefined,
): string {
  const requirements = (policy?.requirements ?? []).map((requirement) => ({
    id: requirement.id,
    label: requirement.label,
    verifier: requirement.verifier,
    anyOf: [...requirement.anyOf].sort(),
    targetPatterns: [...(requirement.targetPatterns ?? [])].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id))
  return createHash("sha256").update(JSON.stringify({
    content: content.trim(),
    requirements,
  })).digest("hex")
}

/**
 * Progress is objective state, not tool activity. With a typed acceptance
 * contract, an inspection advances the loop only when it can bind evidence to
 * at least one requirement. This prevents endless distinct search queries from
 * renewing a planning phase whose only valid transition is `plan`.
 */
function outcomeCanAdvanceObjective(
  policy: ObjectiveAcceptancePolicy | undefined,
  outcome: ToolExecutionOutcome,
): boolean {
  if (outcome.semantics.mutation) return true
  if (!policy) return outcome.semantics.verification
  return bindObjectiveEvidenceToRequirements(policy, outcome).length > 0
}

/**
 * Hash objective-visible input and trusted output, but never executionId.
 * The same invocation returning the same result is a no-op; a changed file
 * read, changed write payload, or changed build result produces a new state.
 */
function progressFingerprint(outcome: ToolExecutionOutcome): string {
  return createHash("sha256").update(stableSerialize({
    name: outcome.name,
    input: outcome.input ?? {},
    result: {
      data: outcome.result.data,
      truncated: Boolean(outcome.result.truncated),
      outcome: outcome.result.outcome
        ? {
            status: outcome.result.outcome.status,
            category: outcome.result.outcome.category,
            summary: outcome.result.outcome.summary,
            exitCode: outcome.result.outcome.exitCode,
            evidence: outcome.result.outcome.evidence,
          }
        : undefined,
    },
    semantics: outcome.semantics,
  })).digest("hex")
}

function invocationSignature(
  name: string,
  input: Record<string, unknown>,
  progressRevision: number,
): string {
  const inputHash = createHash("sha256").update(stableSerialize(input)).digest("hex")
  return `${name}:${inputHash}:progress-${progressRevision}`
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`
}
