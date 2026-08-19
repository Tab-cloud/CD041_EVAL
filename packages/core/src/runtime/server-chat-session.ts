import type { ExecutionSnapshot } from "./agent-loop-control.ts"
import { resumeExecutionSnapshot } from "./agent-loop-control.ts"
import { buildAgentHistory, parseCompactSummary } from "./context-compaction.ts"
import { MessageRepo, SessionRepo } from "../store/repository.ts"
import type { ExecutionScope } from "./tool-policy.ts"

export function prepareSessionTurn(input: {
  existingSession: ReturnType<typeof SessionRepo.get>
  sessionId: string
  requestId: string
  message: string
  agentId: string
  workingDir: string
  requestedModelId?: string
  effort: "on" | "off"
  requestedScope: ExecutionScope
  priorMessageRows: ReturnType<typeof MessageRepo.getBySession>
  resumeSnapshot?: ExecutionSnapshot
}) {
  let session = input.existingSession
  if (!session) {
    session = SessionRepo.create({
      id: input.sessionId,
      title: input.message.slice(0, 30),
      agent_id: input.agentId,
      project_path: input.workingDir !== process.cwd() ? input.workingDir : null,
      composer_model_id: input.requestedModelId ?? null,
      composer_effort: input.effort,
      composer_scope: input.requestedScope,
    })
  } else if (session.agent_id !== input.agentId) {
    SessionRepo.update(input.sessionId, { agent_id: input.agentId })
    session = { ...session, agent_id: input.agentId }
  }
  session = SessionRepo.updateComposerPreferences(input.sessionId, {
    composer_model_id: input.requestedModelId ?? null,
    composer_effort: input.effort,
    composer_scope: input.requestedScope,
  }) ?? session

  const history = buildAgentHistory(input.priorMessageRows, parseCompactSummary(session))
  const resumedExecution = resumeExecutionSnapshot(input.resumeSnapshot)
  const seq = MessageRepo.latestSeq(input.sessionId) + 1
  MessageRepo.create({
    session_id: input.sessionId,
    request_id: input.requestId,
    role: "user",
    content: input.message,
    agent_id: input.agentId,
    tool_calls: null,
    tool_results: null,
    seq,
    timestamp: Date.now(),
  })
  return { session, history, resumedExecution }
}
