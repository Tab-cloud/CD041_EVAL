import type { Database } from "bun:sqlite"

export interface MigrationDefinition {
  version: number
  sql: string
  /**
   * A migration may be replayed through a history hole only when every
   * statement is idempotent. ALTER/rebuild migrations must fail closed.
   */
  replaySafe?: boolean
}

export class DatabaseMigrationHistoryError extends Error {
  readonly code = "database-migration-history-invalid"

  constructor(readonly missingVersions: number[], readonly highestAppliedVersion: number) {
    super(
      `数据库迁移历史不连续：最高版本为 ${highestAppliedVersion}，`
      + `但缺少不可安全重放的版本 ${missingVersions.join(", ")}`,
    )
    this.name = "DatabaseMigrationHistoryError"
  }
}

export class DatabaseSchemaIntegrityError extends Error {
  readonly code = "database-schema-integrity-failed"

  constructor(readonly issues: string[]) {
    super(`数据库结构校验失败：${issues.join("；")}`)
    this.name = "DatabaseSchemaIntegrityError"
  }
}

export class DatabaseSchemaVersionError extends Error {
  readonly code = "database-schema-version-unsupported"

  constructor(readonly databaseVersion: number, readonly supportedVersion: number) {
    super(
      `数据库版本 ${databaseVersion} 高于当前运行时支持的 ${supportedVersion}，`
      + "拒绝用旧运行时打开新数据库",
    )
    this.name = "DatabaseSchemaVersionError"
  }
}

/**
 * Apply every absent migration under BEGIN IMMEDIATE. Looking only at
 * MAX(version) is unsafe because a history hole otherwise becomes permanent.
 * Multiple backend processes may enter this function concurrently; the
 * in-transaction existence check makes each version exactly-once.
 */
export function applyMigrations(
  db: Database,
  migrations: MigrationDefinition[],
): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS _migrations "
    + "(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  )

  const appliedRows = db.query(
    "SELECT version FROM _migrations ORDER BY version ASC",
  ).all() as Array<{ version: number }>
  const applied = new Set(appliedRows.map((row) => row.version))
  const highestApplied = appliedRows.at(-1)?.version ?? 0
  const latestSupported = migrations.at(-1)?.version ?? 0
  if (highestApplied > latestSupported) {
    throw new DatabaseSchemaVersionError(highestApplied, latestSupported)
  }
  const unsafeHistoryHoles = migrations
    .filter((migration) =>
      migration.version < highestApplied
      && !applied.has(migration.version)
      && !migration.replaySafe)
    .map((migration) => migration.version)

  if (unsafeHistoryHoles.length > 0) {
    throw new DatabaseMigrationHistoryError(unsafeHistoryHoles, highestApplied)
  }

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue
    db.transaction(() => {
      const alreadyApplied = db.query(
        "SELECT 1 FROM _migrations WHERE version = ?",
      ).get(migration.version)
      if (alreadyApplied) return
      db.run(migration.sql)
      db.run(
        "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)",
        [migration.version, Date.now()],
      )
    }).immediate()
  }

  assertRuntimeSchema(db, migrations.map((migration) => migration.version))
}

/**
 * Validate durable control-plane tables before publishing the Database
 * singleton. Missing/corrupt structures are reported at startup, never later
 * as an unrelated `no such table` failure inside an Agent task.
 */
export function assertRuntimeSchema(db: Database, expectedVersions: number[]): void {
  const issues: string[] = []
  const quickCheck = db.query("PRAGMA quick_check(1)").get() as Record<string, unknown> | null
  const quickCheckResult = quickCheck ? Object.values(quickCheck)[0] : undefined
  if (quickCheckResult !== "ok") {
    issues.push(`SQLite quick_check=${String(quickCheckResult ?? "无结果")}`)
  }

  const applied = new Set(
    (db.query("SELECT version FROM _migrations").all() as Array<{ version: number }>)
      .map((row) => row.version),
  )
  const missingVersions = expectedVersions.filter((version) => !applied.has(version))
  if (missingVersions.length > 0) {
    issues.push(`缺少迁移版本 ${missingVersions.join(", ")}`)
  }

  const requiredTables: Record<string, string[]> = {
    messages: [
      "id", "session_id", "request_id", "role", "content", "seq", "timestamp",
    ],
    task_runs: ["id", "request_id", "status", "result", "error"],
    run_events: [
      "run_id", "session_id", "seq", "event_type", "payload", "projection_version",
    ],
    session_commands: [
      "request_id", "session_id", "session_seq", "payload", "state",
      "owner_token", "owner_epoch", "task_id", "completed_at",
    ],
    main_agent_interactions: [
      "id", "source_id", "root_run_id", "child_run_id", "session_id", "state",
    ],
    run_guidance: [
      "request_id", "root_run_id", "session_id", "message", "attachments",
      "state", "created_at", "applied_at",
    ],
    runtime_owner_leases: [
      "owner_epoch", "process_id", "heartbeat_at", "lease_expires_at",
    ],
    runtime_leader_lease: [
      "singleton", "owner_epoch", "process_id", "heartbeat_at", "lease_expires_at",
    ],
    model_protocol_capabilities: [
      "identity", "provider", "base_url", "model_id", "native_tools_status",
      "successes", "failures", "last_error", "checked_at",
    ],
    model_protocol_observations: [
      "identity", "observation_scope", "observation_kind", "reason", "observed_at",
    ],
    token_usage_events: [
      "id", "attempt_id", "run_id", "session_id", "agent_id", "scope",
      "operation", "provider_id", "model_id", "prompt_tokens",
      "completion_tokens", "source", "occurred_at", "local_day",
    ],
    token_usage_daily: [
      "local_day", "scope_type", "scope_id", "prompt_tokens",
      "completion_tokens", "calls", "actual_calls", "estimated_calls",
    ],
  }
  for (const [table, requiredColumns] of Object.entries(requiredTables)) {
    const exists = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table)
    if (!exists) {
      issues.push(`缺少表 ${table}`)
      continue
    }
    const columns = new Set(
      (db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map((row) => row.name),
    )
    const missingColumns = requiredColumns.filter((column) => !columns.has(column))
    if (missingColumns.length > 0) {
      issues.push(`表 ${table} 缺少列 ${missingColumns.join(", ")}`)
    }
  }

  const requiredIndexes = [
    "idx_messages_session_request_role",
    "idx_task_runs_request_id",
    "idx_run_events_session",
    "idx_session_commands_head",
    "idx_session_commands_task",
    "idx_main_agent_interactions_source",
    "idx_run_guidance_pending",
    "idx_run_guidance_session",
    "idx_runtime_owner_leases_expiry",
    "idx_runtime_leader_lease_expiry",
    "idx_model_protocol_capabilities_checked",
    "idx_model_protocol_observations_recent",
    "idx_token_usage_events_time",
    "idx_token_usage_events_session",
    "idx_token_usage_daily_scope",
  ]
  const indexRows = db.query(
    "SELECT name FROM sqlite_master WHERE type = 'index'",
  ).all() as Array<{ name: string }>
  const indexes = new Set(indexRows.map((row) => row.name))
  for (const index of requiredIndexes) {
    if (!indexes.has(index)) issues.push(`缺少索引 ${index}`)
  }

  if (issues.length > 0) throw new DatabaseSchemaIntegrityError(issues)
}
