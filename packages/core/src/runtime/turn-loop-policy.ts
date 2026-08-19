export type TurnLoopDecision =
  | { type: "execute-tools" }
  | { type: "continue-output" }
  | { type: "complete" }

export interface TurnLoopState {
  nativeToolCallCount: number
  finishReason?: string
}

/**
 * Owns only the model/tool turn boundary.
 *
 * Objective quality, todos and evidence remain useful diagnostics, but they do
 * not belong in the transport loop. Keeping this policy small preserves the
 * same invariant used by OpenCode/Codex: tool calls are executed and replayed;
 * a completed model turn without tool calls settles the turn.
 */
export abstract class TurnLoopPolicy {
  abstract decide(state: TurnLoopState): TurnLoopDecision
}

export class LightweightTurnLoopPolicy extends TurnLoopPolicy {
  decide(state: TurnLoopState): TurnLoopDecision {
    if (state.nativeToolCallCount > 0) return { type: "execute-tools" }
    if (isOutputLimit(state.finishReason)) return { type: "continue-output" }
    return { type: "complete" }
  }
}

export const turnLoopPolicy = new LightweightTurnLoopPolicy()

function isOutputLimit(reason: string | undefined): boolean {
  return ["length", "max_tokens", "max_output_tokens", "output_limit"]
    .includes(reason?.trim().toLowerCase() ?? "")
}
