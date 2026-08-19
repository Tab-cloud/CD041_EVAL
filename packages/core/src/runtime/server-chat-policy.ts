import type { ModelRouter } from "../model-router/index.ts"
import type { AgentOrchestrator } from "./orchestrator.ts"
import type { ConversationTurnKind } from "./conversation-turn-intent.ts"
import type { SemanticTaskAnalysis } from "./semantic-task-analysis.ts"
import {
  ModelProtocolCapabilityRepo,
  modelProtocolIdentity,
} from "../store/model-protocol-capability.ts"

const rateMap = new Map<string, { count: number; reset: number }>()
const RATE_LIMIT = 30
/** Slash commands select an internal assignee while the main Agent remains owner. */
export function resolveCommandAgent(command: unknown): string | undefined {
  return command === "/init" ? "project-initializer" : undefined
}

export function shouldAutoPlan(
  _scope: string | null,
  _orchestrator: AgentOrchestrator | null,
  _turnKind: ConversationTurnKind,
  _semanticAnalysis: SemanticTaskAnalysis,
): boolean {
  // Automatic execution must not depend on a second, model-authored planning
  // protocol before real tools can run. The semantic `requiresPlanning` flag is
  // advisory context for the main Agent, which may delegate through `task` or
  // `delegate_dag`; exact Agent identities, permissions, resources and terminal
  // state remain runtime-owned. Explicit plan-mode is still available as a
  // user-selected response mode, but normal work starts executing immediately.
  return false
}

export function checkChatRate(key: string): boolean {
  const now = Date.now()
  if (rateMap.size > 500) {
    for (const [entryKey, value] of rateMap) if (now > value.reset) rateMap.delete(entryKey)
  }
  const current = rateMap.get(key)
  if (!current || now > current.reset) {
    rateMap.set(key, { count: 1, reset: now + 60_000 })
    return true
  }
  current.count++
  return current.count <= RATE_LIMIT
}

/**
 * A model chosen in the composer is a hard conversation binding. Automatic
 * routing may use the configured fallback chain, but an explicit selection
 * must fail visibly instead of silently changing model identity.
 */
export function resolveConversationModelFallback(
  requestedModelId: string | undefined,
  configuredFallbackEnabled: boolean,
): boolean {
  return !requestedModelId && configuredFallbackEnabled
}

/**
 * The composer model remains the public conversation model. A distinct model
 * can execute a concrete native tool action without changing that identity.
 */
export function resolveProtocolExecutorModelIds(
  router: ModelRouter | null,
  conversationModelId: string | undefined,
  requiredCapabilities: string[],
  configuredRoute?: { primaryModelId?: string; fallbackModelIds: string[] },
): string[] {
  if (!router) return []
  const conversation = conversationModelId ? router.getModel(conversationModelId) : undefined
  const conversationIdentity = conversation ? modelProtocolIdentity(conversation) : undefined
  const configured = [
    configuredRoute?.primaryModelId,
    ...(configuredRoute?.fallbackModelIds ?? []),
  ].filter((id): id is string => Boolean(id && router.getModel(id)))
  const automatic = router.list
    .filter((model) => modelProtocolIdentity(model) !== conversationIdentity)
    .filter((model) => ModelProtocolCapabilityRepo.status(model) !== "unsupported")
    .filter((model) => requiredCapabilities.every((capability) =>
      model.capabilities.includes(capability as any)))
    .map((model) => model.id)
  const identities = new Set<string>()
  const result: string[] = []
  for (const id of [...configured, ...automatic]) {
    const model = router.getModel(id)
    if (!model) continue
    const identity = modelProtocolIdentity(model)
    if (identity === conversationIdentity
      || identities.has(identity)
      || ModelProtocolCapabilityRepo.status(model) === "unsupported"
      || !requiredCapabilities.every((capability) =>
        model.capabilities.includes(capability as any))) continue
    identities.add(identity)
    result.push(id)
    if (result.length === 5) break
  }
  return result
}
