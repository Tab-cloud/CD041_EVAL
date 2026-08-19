import { createHash } from "node:crypto"
import type { ModelConfig } from "../model-router/types.ts"
import { getDb } from "./database.ts"

export type NativeToolProtocolStatus = "unknown" | "verified" | "unsupported"

export interface ModelProtocolCapabilityView {
  identity: string
  provider: string
  baseUrl: string
  modelId: string
  nativeToolsStatus: Exclude<NativeToolProtocolStatus, "unknown">
  successes: number
  failures: number
  lastError?: string
  checkedAt: number
}

export type NativeToolProtocolObservationKind =
  | "verified"
  | "conclusive-failure"
  | "transient-failure"

export interface NativeToolProtocolObservation {
  identity: string
  scope: string
  kind: NativeToolProtocolObservationKind
  reason?: string
  observedAt: number
}

interface ModelProtocolCapabilityRow {
  identity: string
  provider: string
  base_url: string
  model_id: string
  native_tools_status: Exclude<NativeToolProtocolStatus, "unknown">
  successes: number
  failures: number
  last_error: string | null
  checked_at: number
}

const UNSUPPORTED_RECHECK_MS = 24 * 60 * 60 * 1_000
const CONCLUSIVE_FAILURE_THRESHOLD = 2

/**
 * Tool calling is a measured wire-protocol capability, never a model-name
 * heuristic or a user-maintained checkbox.
 */
export const ModelProtocolCapabilityRepo = {
  get(model: ModelConfig): ModelProtocolCapabilityView | null {
    const row = getDb().query(
      "SELECT * FROM model_protocol_capabilities WHERE identity = ?",
    ).get(modelProtocolIdentity(model)) as ModelProtocolCapabilityRow | null
    return row ? mapRow(row) : null
  },

  status(model: ModelConfig, now = Date.now()): NativeToolProtocolStatus {
    const record = this.get(model)
    if (!record) return "unknown"
    if (record.nativeToolsStatus === "unsupported") {
      if (now - record.checkedAt >= UNSUPPORTED_RECHECK_MS) return "unknown"
      // The projection is never trusted without its independent evidence
      // ledger. This also invalidates a legacy single-failure quarantine when
      // migration 39 first opens an existing database.
      if (conclusiveFailureStreak(record.identity, now) < CONCLUSIVE_FAILURE_THRESHOLD) {
        return record.successes > 0 ? "verified" : "unknown"
      }
    }
    return record.nativeToolsStatus
  },

  recordConclusiveFailure(
    model: ModelConfig,
    reason: string,
    scope: string,
    now = Date.now(),
  ): ModelProtocolCapabilityView | null {
    return this.observe(model, {
      kind: "conclusive-failure",
      reason,
      scope,
      observedAt: now,
    }).capability
  },

  recordTransientFailure(
    model: ModelConfig,
    reason: string,
    scope: string,
    now = Date.now(),
  ): ModelProtocolCapabilityView | null {
    return this.observe(model, {
      kind: "transient-failure",
      reason,
      scope,
      observedAt: now,
    }).capability
  },

  observe(
    model: ModelConfig,
    observation: Omit<NativeToolProtocolObservation, "identity" | "observedAt">
      & { observedAt?: number },
  ): { recorded: boolean; capability: ModelProtocolCapabilityView | null } {
    const identity = modelProtocolIdentity(model)
    const now = observation.observedAt ?? Date.now()
    const scope = observation.scope.trim()
    if (!scope) throw new Error("模型协议观测必须具备非空 observation scope")
    const baseUrl = normalizeBaseUrl(model)
    const db = getDb()
    return db.transaction(() => {
      const previous = db.query(
        `SELECT observation_kind
         FROM model_protocol_observations
         WHERE identity = ? AND observation_scope = ?`,
      ).get(identity, scope) as {
        observation_kind: NativeToolProtocolObservationKind
      } | null
      if (previous) {
        // A successful retry is stronger than an earlier failure in the same
        // execution scope. Other duplicates are the same evidence and cannot
        // increment the verdict.
        if (observation.kind !== "verified"
          || previous.observation_kind === "verified") {
          return { recorded: false, capability: this.get(model) }
        }
        db.run(
          `UPDATE model_protocol_observations
           SET observation_kind = 'verified', reason = NULL, observed_at = ?
           WHERE identity = ? AND observation_scope = ?`,
          [now, identity, scope],
        )
      } else {
        db.run(
          `INSERT INTO model_protocol_observations
           (identity, observation_scope, observation_kind, reason, observed_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            identity,
            scope,
            observation.kind,
            observation.reason?.slice(0, 2_000) ?? null,
            now,
          ],
        )
      }

      if (observation.kind === "transient-failure") {
        return { recorded: true, capability: this.get(model) }
      }
      if (observation.kind === "verified") {
        upsertProjection(db, model, identity, baseUrl, "verified", 1, 0, undefined, now)
        return { recorded: true, capability: this.get(model) }
      }

      const streak = conclusiveFailureStreak(identity, now)
      const existing = this.get(model)
      if (streak < CONCLUSIVE_FAILURE_THRESHOLD) {
        if (existing) {
          db.run(
            `UPDATE model_protocol_capabilities
             SET failures = failures + 1, last_error = ?
             WHERE identity = ?`,
            [observation.reason?.slice(0, 2_000) ?? null, identity],
          )
        }
        return { recorded: true, capability: this.get(model) }
      }
      upsertProjection(
        db,
        model,
        identity,
        baseUrl,
        "unsupported",
        0,
        existing ? 1 : streak,
        observation.reason,
        now,
      )
      return { recorded: true, capability: this.get(model) }
    }).immediate()
  },

  observations(model: ModelConfig, limit = 20): NativeToolProtocolObservation[] {
    const identity = modelProtocolIdentity(model)
    const rows = getDb().query(
      `SELECT observation_scope, observation_kind, reason, observed_at
       FROM model_protocol_observations
       WHERE identity = ?
       ORDER BY observed_at DESC, rowid DESC
       LIMIT ?`,
    ).all(identity, Math.max(1, Math.min(200, limit))) as Array<{
      observation_scope: string
      observation_kind: NativeToolProtocolObservationKind
      reason: string | null
      observed_at: number
    }>
    return rows.map((row) => ({
      identity,
      scope: row.observation_scope,
      kind: row.observation_kind,
      reason: row.reason ?? undefined,
      observedAt: row.observed_at,
    }))
  },
}

function upsertProjection(
  db: ReturnType<typeof getDb>,
  model: ModelConfig,
  identity: string,
  baseUrl: string,
  status: Exclude<NativeToolProtocolStatus, "unknown">,
  successes: number,
  failures: number,
  error: string | undefined,
  checkedAt: number,
): void {
  db.run(
    `INSERT INTO model_protocol_capabilities
     (identity, provider, base_url, model_id, native_tools_status,
      successes, failures, last_error, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(identity) DO UPDATE SET
       native_tools_status = excluded.native_tools_status,
       successes = model_protocol_capabilities.successes + excluded.successes,
       failures = model_protocol_capabilities.failures + excluded.failures,
       last_error = excluded.last_error,
       checked_at = excluded.checked_at`,
    [
      identity,
      model.provider.trim().toLowerCase(),
      baseUrl,
      model.modelId.trim(),
      status,
      successes,
      failures,
      error?.slice(0, 2_000) ?? null,
      checkedAt,
    ],
  )
}

function conclusiveFailureStreak(identity: string, now: number): number {
  const rows = getDb().query(
    `SELECT observation_kind
     FROM model_protocol_observations
     WHERE identity = ? AND observed_at >= ?
     ORDER BY observed_at DESC, rowid DESC`,
  ).all(identity, now - UNSUPPORTED_RECHECK_MS) as Array<{
    observation_kind: NativeToolProtocolObservationKind
  }>
  let failures = 0
  for (const row of rows) {
    if (row.observation_kind === "verified") break
    if (row.observation_kind === "conclusive-failure") failures++
  }
  return failures
}

export function modelProtocolIdentity(model: ModelConfig): string {
  // Some compatible gateways enable tool calling per account. Including the
  // credential revision inside the final hash prevents one account's measured
  // capability from poisoning another without persisting or exposing secrets.
  const value = [
    model.provider.trim().toLowerCase(),
    normalizeBaseUrl(model),
    model.modelId.trim(),
    model.apiKey?.trim() ?? "",
  ].join("\u0000")
  return createHash("sha256").update(value).digest("hex")
}

function normalizeBaseUrl(model: ModelConfig): string {
  return (model.baseUrl?.trim() || defaultBaseUrl(model.provider))
    .replace(/\/+$/, "")
    .toLowerCase()
}

function defaultBaseUrl(provider: string): string {
  if (provider === "openai") return "https://api.openai.com/v1"
  if (provider === "anthropic") return "https://api.anthropic.com"
  return provider.trim().toLowerCase()
}

function mapRow(row: ModelProtocolCapabilityRow): ModelProtocolCapabilityView {
  return {
    identity: row.identity,
    provider: row.provider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    nativeToolsStatus: row.native_tools_status,
    successes: row.successes,
    failures: row.failures,
    lastError: row.last_error ?? undefined,
    checkedAt: row.checked_at,
  }
}
