export interface VerificationGapDecisionInput {
  hasAcceptancePolicy: boolean
  objectiveAccepted: boolean
  mutationVerificationPending: boolean
}

export interface NativeRecoveryDecisionInput {
  activeRecovery: boolean
  requiredPhaseToolPending: boolean
  consecutiveNoProgress: number
  outstandingWorkCount: number
}

export interface SuccessfulToolStagnationInput {
  consecutiveNoProgress: number
}

/**
 * Owns the boundary between ordinary model continuation, objective completion,
 * and typed failure recovery. Keeping these decisions in one policy prevents a
 * progress heuristic from silently becoming a provider protocol requirement.
 */
export abstract class ExecutionControlPolicy {
  abstract verificationGapIsBlocking(input: VerificationGapDecisionInput): boolean
  abstract requiresNativeTool(input: NativeRecoveryDecisionInput): boolean
  abstract successfulToolStagnationIsTerminal(input: SuccessfulToolStagnationInput): boolean
}

/**
 * Keep the transport loop authoritative, matching OpenCode/Codex: successful
 * tool results return to the model and a later tool-free model turn completes
 * the task. Evidence remains useful for an explicitly compiled phase contract,
 * but ordinary writes cannot invent a completion gate. Repeated successful
 * no-ops are bounded by the existing step budget instead of being reclassified
 * as task failures.
 */
export class LightweightExecutionControlPolicy extends ExecutionControlPolicy {
  verificationGapIsBlocking(input: VerificationGapDecisionInput): boolean {
    if (!input.mutationVerificationPending) return false
    return input.hasAcceptancePolicy && !input.objectiveAccepted
  }

  requiresNativeTool(input: NativeRecoveryDecisionInput): boolean {
    // Scope and authorization enforce user-selected boundaries. Phase and
    // recovery metadata are guidance, never provider-level tool coercion.
    void input
    return false
  }

  successfulToolStagnationIsTerminal(_input: SuccessfulToolStagnationInput): boolean {
    return false
  }
}

export const executionControlPolicy = new LightweightExecutionControlPolicy()
