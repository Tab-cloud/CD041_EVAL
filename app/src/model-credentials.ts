import { invoke } from "@tauri-apps/api/core"
import type { ModelConfig } from "./types"

export interface CredentialSyncResult {
  backend: string
  configured: number
}

export interface CredentialStageResult extends CredentialSyncResult {
  transactionId: string
}

export interface CredentialHealth {
  backend: string
  available: boolean
  healthy: boolean
  modelRecords: number
  modelCredentials: number
  mcpExpected: number
  mcpCredentials: number
  mcpMissing: number
  webhookConfigured: boolean
  readErrors: number
  rotationDays: number
  rotationDue: number
  oldestCredentialAt: number | null
  newestCredentialAt: number | null
  checkedAt: number
}

export interface SecurityAuditEntry {
  id: string
  event: string
  status: "success" | "failed"
  detail: string
  createdAt: number
}

export function usesSystemCredentialStore(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function syncModelCredentials(models: ModelConfig[]): Promise<CredentialSyncResult | null> {
  if (!usesSystemCredentialStore()) return null
  return invoke<CredentialSyncResult>("sync_model_credentials", { models: modelCredentialInputs(models) })
}

export async function syncMcpCredentials(servers: Array<Record<string, unknown>>): Promise<CredentialSyncResult | null> {
  if (!usesSystemCredentialStore()) return null
  return invoke<CredentialSyncResult>("sync_mcp_credentials", { servers: mcpCredentialInputs(servers) })
}

export async function syncWorkflowWebhookCredential(secret: string, clear: boolean): Promise<CredentialSyncResult | null> {
  if (!usesSystemCredentialStore()) return null
  return invoke<CredentialSyncResult>("sync_workflow_webhook_credential", { secret, clear })
}

export async function stageModelCredentials(models: ModelConfig[]): Promise<CredentialStageResult | null> {
  if (!usesSystemCredentialStore()) return null
  return invoke<CredentialStageResult>("stage_model_credentials", { models: modelCredentialInputs(models) })
}

export async function stageMcpCredentials(servers: Array<Record<string, unknown>>): Promise<CredentialStageResult | null> {
  if (!usesSystemCredentialStore()) return null
  return invoke<CredentialStageResult>("stage_mcp_credentials", { servers: mcpCredentialInputs(servers) })
}

export async function stageWorkflowWebhookCredential(secret: string, clear: boolean): Promise<CredentialStageResult | null> {
  if (!usesSystemCredentialStore()) return null
  return invoke<CredentialStageResult>("stage_workflow_webhook_credential", { secret, clear })
}

export async function finishCredentialTransaction(transactionId: string, commit: boolean): Promise<void> {
  if (!usesSystemCredentialStore() || !transactionId) return
  await invoke("finish_credential_transaction", { transactionId, commit })
}

export async function runCredentialTransaction<T>(
  stage: Promise<CredentialStageResult | null>,
  saveConfiguration: () => Promise<T>,
): Promise<T> {
  const staged = await stage
  let result: T
  try {
    result = await saveConfiguration()
  } catch (error) {
    if (staged) {
      try {
        await finishCredentialTransaction(staged.transactionId, false)
      } catch (rollbackError) {
        throw new Error(`${messageOf(error)}；系统凭据回滚失败: ${messageOf(rollbackError)}`)
      }
    }
    throw error
  }
  if (staged) await finishCredentialTransaction(staged.transactionId, true)
  return result
}

export async function getCredentialHealth(rotationDays = 90): Promise<CredentialHealth | null> {
  if (!usesSystemCredentialStore()) return null
  return invoke<CredentialHealth>("get_credential_health", { rotationDays })
}

export async function getSecurityAudit(limit = 20): Promise<SecurityAuditEntry[]> {
  if (!usesSystemCredentialStore()) return []
  return invoke<SecurityAuditEntry[]>("get_security_audit", { limit })
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string")
}

function modelCredentialInputs(models: ModelConfig[]) {
  return models.map((model) => ({
    id: model.id,
    apiKey: model.apiKey ?? "",
    clear: Boolean(model.clearApiKey),
  }))
}

function mcpCredentialInputs(servers: Array<Record<string, unknown>>) {
  return servers.map((server) => ({
    id: server.id,
    ...(isStringRecord(server.env) ? { env: server.env } : {}),
    ...(isStringRecord(server.headers) ? { headers: server.headers } : {}),
  }))
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
