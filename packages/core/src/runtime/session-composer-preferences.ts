import type { ModelRouter } from "../model-router/index.ts"
import type { SessionRow } from "../store/repository.ts"
import { normalizeScope } from "./tool-policy.ts"
import type { SystemSettings } from "./system-settings.ts"

export interface SessionComposerPreferences {
  modelId: string | null
  effort: "on" | "off"
  scope: "confirm-changes" | "auto-edit" | "plan-mode" | "full-access"
}

export function resolveInitialSessionComposerPreferences(
  value: unknown,
  defaults: Pick<SystemSettings, "defaultModelId" | "defaultEffort" | "defaultScope">,
  modelRouter?: ModelRouter | null,
): Pick<SessionRow, "composer_model_id" | "composer_effort" | "composer_scope"> {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const hasModel = Object.hasOwn(input, "modelId")
  const requestedModel = typeof input.modelId === "string" ? input.modelId.trim() : ""
  const defaultModel = defaults.defaultModelId.trim()
  const modelId = hasModel
    ? requestedModel && requestedModel !== "auto" && modelRouter?.getModel(requestedModel) ? requestedModel : null
    : defaultModel && modelRouter?.getModel(defaultModel) ? defaultModel : null
  return {
    composer_model_id: modelId,
    composer_effort: input.effort === "on" || input.effort === "off" ? input.effort : defaults.defaultEffort,
    composer_scope: normalizeScope(input.scope) ?? defaults.defaultScope,
  }
}

export function projectSessionComposerPreferences(
  session: SessionRow,
  modelRouter?: ModelRouter | null,
): SessionComposerPreferences {
  const storedModelId = session.composer_model_id?.trim() || null
  return {
    modelId: storedModelId && modelRouter?.getModel(storedModelId) ? storedModelId : null,
    effort: session.composer_effort === "off" ? "off" : "on",
    scope: normalizeScope(session.composer_scope) ?? "auto-edit",
  }
}

export function parseSessionComposerPreferencePatch(
  value: unknown,
  modelRouter?: ModelRouter | null,
): {
  sessionId: string
  fields: Partial<Pick<SessionRow, "composer_model_id" | "composer_effort" | "composer_scope">>
} | { error: string } {
  if (!value || typeof value !== "object") return { error: "请求内容无效" }
  const body = value as Record<string, unknown>
  if (typeof body.sessionId !== "string" || !body.sessionId.trim()) return { error: "缺少有效的 sessionId" }
  const fields: Partial<Pick<SessionRow, "composer_model_id" | "composer_effort" | "composer_scope">> = {}

  if ("modelId" in body) {
    if (body.modelId !== null && typeof body.modelId !== "string") return { error: "modelId 无效" }
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : ""
    if (modelId && modelId !== "auto" && !modelRouter?.getModel(modelId)) return { error: `未知模型: ${modelId}` }
    fields.composer_model_id = modelId && modelId !== "auto" ? modelId : null
  }
  if ("effort" in body) {
    if (body.effort !== "on" && body.effort !== "off") return { error: "effort 无效" }
    fields.composer_effort = body.effort
  }
  if ("scope" in body) {
    const scope = normalizeScope(body.scope)
    if (!scope) return { error: "scope 无效" }
    fields.composer_scope = scope
  }
  if (Object.keys(fields).length === 0) return { error: "没有可更新的会话设置" }
  return { sessionId: body.sessionId.trim(), fields }
}
