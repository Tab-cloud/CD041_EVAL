import type { ExecutionScope, ToolAuthorization } from "./tool-policy.ts"
import { logOrchestrationEvent } from "./orchestration-log.ts"

interface RuntimeAccessState {
  scope: ExecutionScope
  approveAll: boolean
  updatedAt: number
}

/**
 * Mutable permissions for an active session run.
 *
 * The chat request establishes the initial state. Approval actions and the
 * scope selector may then update it while the agent loop is still running.
 */
export class RuntimeAccessManager {
  private readonly sessions = new Map<string, RuntimeAccessState>()

  begin(sessionId: string, scope: ExecutionScope): RuntimeAccessState {
    return this.set(sessionId, scope, scope === "full-access")
  }

  set(sessionId: string, scope: ExecutionScope, approveAll = scope === "full-access"): RuntimeAccessState {
    const state = { scope, approveAll, updatedAt: Date.now() }
    this.sessions.set(sessionId, state)
    logOrchestrationEvent({
      sessionId,
      runId: sessionId,
      eventType: "permission.scope-changed",
      message: "会话执行权限范围已更新",
      data: { scope, approveAll },
    })
    return state
  }

  allowAll(sessionId: string): RuntimeAccessState {
    return this.set(sessionId, "full-access", true)
  }

  getScope(sessionId: string, fallback: ExecutionScope): ExecutionScope {
    return this.sessions.get(sessionId)?.scope ?? fallback
  }

  shouldApprove(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.approveAll === true
  }

  /** Apply the active run grant without weakening hard deny decisions. */
  resolveAuthorization(contextId: string, authorization: ToolAuthorization): ToolAuthorization {
    if (authorization.action === "ask" && this.shouldApprove(contextId)) return { action: "allow" }
    return authorization
  }

  get(sessionId: string): RuntimeAccessState | null {
    return this.sessions.get(sessionId) ?? null
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

export const runtimeAccessManager = new RuntimeAccessManager()
