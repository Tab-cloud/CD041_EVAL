/**
 * SQLite Database — 初始化 + 迁移
 *
 * 使用 Bun 内置 bun:sqlite，零依赖。
 * 数据库文件: ~/.eval/eval.db
 */

import { Database } from "bun:sqlite"
import { ensureEvalDataDir, EVAL_DATABASE_PATH } from "./runtime-data-paths.ts"
import {
  applyMigrations,
  type MigrationDefinition,
} from "./database-schema.ts"

let _db: Database | null = null
const OPEN_RETRY_LIMIT = 20
const OPEN_RETRY_BASE_MS = 10

export function getDb(): Database {
  if (_db) return _db

  ensureEvalDataDir()

  for (let attempt = 0; attempt < OPEN_RETRY_LIMIT; attempt++) {
    const candidate = new Database(EVAL_DATABASE_PATH)
    try {
      // Configure contention handling before WAL negotiation because two
      // backend processes may open the same database during an app restart.
      candidate.run("PRAGMA busy_timeout = 5000")
      candidate.run("PRAGMA journal_mode = WAL")
      candidate.run("PRAGMA foreign_keys = ON")
      migrateDatabase(candidate)
      // Publish only a fully migrated and validated connection. A failed
      // migration must never poison the process-wide singleton.
      _db = candidate
      return candidate
    } catch (error) {
      candidate.close()
      if (!isDatabaseBusy(error) || attempt === OPEN_RETRY_LIMIT - 1) throw error
      // WAL negotiation is the one SQLite startup operation that can return
      // SQLITE_BUSY without honoring busy_timeout. Retrying the entire,
      // transaction-safe bootstrap is the inter-process coordination path.
      Bun.sleepSync(Math.min(100, OPEN_RETRY_BASE_MS * (attempt + 1)))
    }
  }
  throw new Error("数据库初始化未完成")
}

export function migrateDatabase(db: Database): void {
  const migrations: MigrationDefinition[] = [
    {
      version: 1,
      sql: `
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          project_path TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
          content TEXT NOT NULL,
          agent_id TEXT,
          tool_calls TEXT,
          tool_results TEXT,
          seq INTEGER NOT NULL,
          timestamp INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          chip TEXT,
          chip_family TEXT,
          config TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `,
    },
    {
      version: 2,
      sql: `
        ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN summary TEXT;
      `,
    },
    {
      version: 3,
      sql: `
        ALTER TABLE sessions ADD COLUMN compact_summary TEXT;
        ALTER TABLE sessions ADD COLUMN compact_at INTEGER;
      `,
    },
    {
      version: 4,
      // 加 UNIQUE(session_id, seq) 约束防止并发请求产生重复 seq
      // SQLite 不支持直接给已有表加 UNIQUE 约束，需要重建索引
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
      `,
    },
    {
      version: 5,
      sql: `
        ALTER TABLE sessions ADD COLUMN schematics TEXT;
        ALTER TABLE sessions ADD COLUMN documents TEXT;
      `,
    },
    {
      version: 6,
      sql: `
        CREATE TABLE IF NOT EXISTS tool_executions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_input TEXT NOT NULL,
          status TEXT NOT NULL,
          working_dir TEXT,
          file_path TEXT,
          before_exists INTEGER,
          before_content TEXT,
          after_hash TEXT,
          diff TEXT,
          lines_added INTEGER NOT NULL DEFAULT 0,
          lines_removed INTEGER NOT NULL DEFAULT 0,
          reversible INTEGER NOT NULL DEFAULT 0,
          result TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          undone_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_tool_executions_session
          ON tool_executions(session_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_executions_call
          ON tool_executions(tool_call_id);
      `,
    },
    {
      version: 7,
      sql: `
        CREATE TABLE IF NOT EXISTS task_runs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          priority INTEGER NOT NULL,
          status TEXT NOT NULL,
          message TEXT NOT NULL,
          working_dir TEXT NOT NULL,
          task_type TEXT NOT NULL,
          scope TEXT,
          effort TEXT,
          model_id TEXT,
          retry_of TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_task_runs_session
          ON task_runs(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_task_runs_status
          ON task_runs(status, created_at DESC);
      `,
    },
    {
      version: 8,
      sql: `
        CREATE TABLE IF NOT EXISTS llm_call_logs (
          id TEXT PRIMARY KEY,
          model_id TEXT NOT NULL,
          model_name TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          prompt_summary TEXT NOT NULL,
          response_summary TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL,
          latency INTEGER NOT NULL,
          success INTEGER NOT NULL,
          error TEXT,
          route_reason TEXT,
          route_attempts TEXT,
          timestamp INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_llm_call_logs_timestamp
          ON llm_call_logs(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_llm_call_logs_model
          ON llm_call_logs(model_id, timestamp DESC);
      `,
    },
    {
      version: 9,
      sql: `
        CREATE TABLE IF NOT EXISTS workflow_runs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          template_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          working_dir TEXT NOT NULL,
          status TEXT NOT NULL,
          current_node_id TEXT,
          report TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workflow_nodes (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          title TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          depends_on TEXT NOT NULL DEFAULT '[]',
          result TEXT,
          error TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          task_run_id TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL,
          UNIQUE(workflow_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS workflow_schedules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          template_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          working_dir TEXT NOT NULL,
          frequency TEXT NOT NULL,
          interval_minutes INTEGER,
          next_run_at INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at INTEGER,
          last_workflow_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_runs_session
          ON workflow_runs(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
          ON workflow_runs(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workflow_nodes_run
          ON workflow_nodes(workflow_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_workflow_schedules_due
          ON workflow_schedules(enabled, next_run_at);
      `,
    },
    {
      version: 10,
      sql: `
        CREATE TABLE IF NOT EXISTS workflow_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          definition TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_templates_updated
          ON workflow_templates(updated_at DESC);
      `,
    },
    {
      version: 11,
      sql: `
        CREATE TABLE IF NOT EXISTS workflow_webhook_settings (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL DEFAULT '',
          secret TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workflow_webhook_deliveries (
          id TEXT PRIMARY KEY,
          workflow_id TEXT,
          event TEXT NOT NULL,
          url TEXT NOT NULL,
          status TEXT NOT NULL,
          http_status INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workflow_id, event)
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_webhook_deliveries_created
          ON workflow_webhook_deliveries(created_at DESC);

        INSERT OR IGNORE INTO workflow_webhook_settings
          (id, url, secret, enabled, created_at, updated_at)
          VALUES ('default', '', '', 0, strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000);
      `,
    },
    {
      version: 12,
      sql: `
        ALTER TABLE workflow_nodes
          ADD COLUMN condition TEXT NOT NULL DEFAULT '';
        ALTER TABLE workflow_runs
          ADD COLUMN failure_policy TEXT NOT NULL DEFAULT '{"maxRetries":0,"delaySeconds":0}';
        ALTER TABLE workflow_webhook_settings
          ADD COLUMN events TEXT NOT NULL DEFAULT '["completed","failed"]';
      `,
    },
    {
      version: 13,
      sql: `
        CREATE TABLE IF NOT EXISTS execution_runs (
          task_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          state TEXT NOT NULL,
          snapshot TEXT NOT NULL,
          stop_reason TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `,
    },
    {
      version: 14,
      sql: `
        CREATE INDEX IF NOT EXISTS idx_execution_runs_session
          ON execution_runs(session_id, updated_at DESC);
      `,
    },
    {
      version: 15,
      sql: `
        CREATE INDEX IF NOT EXISTS idx_execution_runs_state
          ON execution_runs(state, updated_at DESC);
      `,
    },
    {
      version: 16,
      sql: `
        ALTER TABLE execution_runs ADD COLUMN parent_run_id TEXT;
        ALTER TABLE execution_runs ADD COLUMN run_type TEXT NOT NULL DEFAULT 'root';
        ALTER TABLE tool_executions ADD COLUMN run_id TEXT;
        ALTER TABLE tool_executions ADD COLUMN parent_run_id TEXT;

        CREATE INDEX IF NOT EXISTS idx_execution_runs_lineage
          ON execution_runs(session_id, parent_run_id, run_type, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_executions_run
          ON tool_executions(run_id, started_at DESC);
      `,
    },
    {
      version: 17,
      sql: `
        CREATE TABLE IF NOT EXISTS tool_approvals (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          parent_run_id TEXT,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_input TEXT NOT NULL,
          reason TEXT NOT NULL,
          target TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_tool_approvals_session
          ON tool_approvals(session_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_tool_approvals_run
          ON tool_approvals(run_id, status, created_at);
      `,
    },
    {
      version: 18,
      sql: `
        CREATE TABLE IF NOT EXISTS run_events (
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_run_events_session
          ON run_events(session_id, created_at DESC);
      `,
    },
    {
      version: 19,
      sql: `
        ALTER TABLE task_runs ADD COLUMN request_id TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_request_id
          ON task_runs(request_id) WHERE request_id IS NOT NULL;
      `,
    },
    {
      version: 20,
      sql: `
        CREATE TABLE IF NOT EXISTS agent_orchestration_logs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          parent_run_id TEXT,
          agent_id TEXT,
          event_type TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_orchestration_logs_session
          ON agent_orchestration_logs(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_orchestration_logs_run
          ON agent_orchestration_logs(run_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_agent_orchestration_logs_parent
          ON agent_orchestration_logs(parent_run_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_agent_orchestration_logs_type
          ON agent_orchestration_logs(event_type, created_at DESC);
      `,
    },
    {
      version: 21,
      sql: `
        CREATE TABLE IF NOT EXISTS run_contracts (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          parent_run_id TEXT,
          agent_id TEXT NOT NULL,
          contract TEXT NOT NULL,
          result TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_contracts_parent
          ON run_contracts(parent_run_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_run_contracts_session
          ON run_contracts(session_id, created_at DESC);
        ALTER TABLE workflow_nodes ADD COLUMN resource_claims TEXT NOT NULL DEFAULT '{"reads":[],"writes":[]}';
      `,
    },
    {
      version: 22,
      sql: `
        ALTER TABLE task_runs ADD COLUMN parent_run_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_task_runs_parent
          ON task_runs(parent_run_id, created_at ASC);
      `,
    },
    {
      version: 23,
      sql: `
        ALTER TABLE sessions ADD COLUMN main_agent_instance_id TEXT;
        UPDATE sessions
        SET main_agent_instance_id = 'main-' || id
        WHERE main_agent_instance_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_main_agent_instance
          ON sessions(main_agent_instance_id);
      `,
    },
    {
      version: 24,
      sql: `
        ALTER TABLE run_contracts ADD COLUMN logical_task_id TEXT;
        ALTER TABLE run_contracts ADD COLUMN revision_of TEXT;
        ALTER TABLE run_contracts ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
        UPDATE run_contracts
        SET logical_task_id = run_id
        WHERE logical_task_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_run_contracts_logical_task
          ON run_contracts(session_id, logical_task_id, attempt ASC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_run_contracts_revision_once
          ON run_contracts(revision_of) WHERE revision_of IS NOT NULL;
      `,
    },
    {
      version: 25,
      sql: `
        CREATE TABLE IF NOT EXISTS run_graphs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          owner_instance_id TEXT NOT NULL,
          status TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_graphs_session
          ON run_graphs(session_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS run_graph_nodes (
          id TEXT PRIMARY KEY,
          graph_id TEXT NOT NULL REFERENCES run_graphs(id) ON DELETE CASCADE,
          parent_node_id TEXT,
          logical_task_id TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          kind TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          status TEXT NOT NULL,
          contract_ref TEXT,
          result_ref TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_graph_nodes_graph
          ON run_graph_nodes(graph_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_run_graph_nodes_logical
          ON run_graph_nodes(graph_id, logical_task_id, attempt ASC);

        CREATE TABLE IF NOT EXISTS run_graph_edges (
          graph_id TEXT NOT NULL REFERENCES run_graphs(id) ON DELETE CASCADE,
          from_node_id TEXT NOT NULL,
          to_node_id TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (graph_id, from_node_id, to_node_id, edge_type)
        );

        CREATE TABLE IF NOT EXISTS run_graph_events (
          graph_id TEXT NOT NULL REFERENCES run_graphs(id) ON DELETE CASCADE,
          graph_version INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (graph_id, graph_version)
        );
      `,
    },
    {
      // Version numbers are part of the durable migration protocol. Keep
      // retired schema slots inert so migration history remains contiguous.
      version: 26,
      replaySafe: true,
      sql: "SELECT 1;",
    },
    {
      version: 27,
      sql: `
        CREATE TABLE IF NOT EXISTS workspace_revisions (
          workspace TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_change_sets (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE,
          workspace TEXT NOT NULL,
          base_revision INTEGER NOT NULL,
          committed_revision INTEGER,
          status TEXT NOT NULL,
          execution_ids TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_change_sets_workspace
          ON workspace_change_sets(workspace, created_at DESC);
      `,
    },
    {
      version: 28,
      sql: `
        CREATE TABLE IF NOT EXISTS model_attempts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          operation TEXT NOT NULL,
          segment INTEGER NOT NULL,
          step INTEGER NOT NULL,
          attempt INTEGER NOT NULL,
          model_key TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_name TEXT NOT NULL,
          fault_domain TEXT NOT NULL,
          status TEXT NOT NULL,
          failure_kind TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          latency INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_model_attempts_run
          ON model_attempts(run_id, started_at ASC);
        CREATE INDEX IF NOT EXISTS idx_model_attempts_fault_domain
          ON model_attempts(fault_domain, completed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_model_attempts_model
          ON model_attempts(model_key, completed_at DESC);
      `,
    },
    {
      version: 29,
      sql: `
        CREATE TABLE IF NOT EXISTS session_artifact_state (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS session_artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          slot TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT NOT NULL,
          source_hash TEXT,
          revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(session_id, kind, source, slot)
        );
        CREATE INDEX IF NOT EXISTS idx_session_artifacts_session_revision
          ON session_artifacts(session_id, revision ASC);
      `,
    },
    {
      version: 30,
      sql: `
        ALTER TABLE sessions ADD COLUMN composer_model_id TEXT;
        ALTER TABLE sessions ADD COLUMN composer_effort TEXT NOT NULL DEFAULT 'on'
          CHECK(composer_effort IN ('on', 'off'));
        ALTER TABLE sessions ADD COLUMN composer_scope TEXT NOT NULL DEFAULT 'auto-edit'
          CHECK(composer_scope IN ('confirm-changes', 'auto-edit', 'plan-mode', 'full-access'));
      `,
    },
    {
      version: 31,
      sql: `
        CREATE TABLE IF NOT EXISTS build_log_lines (
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL,
          stream_type TEXT NOT NULL CHECK(stream_type IN ('stdout', 'stderr', 'info')),
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(run_id, event_seq)
        );
      `,
    },
    {
      version: 32,
      sql: `
        CREATE INDEX IF NOT EXISTS idx_build_log_lines_session
          ON build_log_lines(session_id, created_at ASC, run_id ASC, event_seq ASC);
      `,
    },
    {
      version: 33,
      sql: `
        CREATE TABLE IF NOT EXISTS conversation_objectives (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_message_id TEXT NOT NULL,
          content TEXT NOT NULL,
          task_count INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('proposed', 'active', 'completed', 'superseded')),
          active_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(session_id, source_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_objectives_open
          ON conversation_objectives(session_id, state, updated_at DESC);
      `,
    },
    {
      version: 34,
      replaySafe: true,
      sql: `
        CREATE TABLE IF NOT EXISTS session_commands (
          request_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          session_seq INTEGER NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL
            CHECK(state IN ('pending', 'processing', 'accepted', 'completed', 'failed', 'cancelled')),
          owner_token TEXT,
          owner_epoch TEXT,
          task_id TEXT UNIQUE,
          error TEXT,
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          completed_at INTEGER,
          UNIQUE(session_id, session_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_session_commands_head
          ON session_commands(session_id, state, session_seq ASC);
        CREATE INDEX IF NOT EXISTS idx_session_commands_task
          ON session_commands(task_id);
      `,
    },
    {
      version: 35,
      replaySafe: true,
      sql: `
        CREATE TABLE IF NOT EXISTS main_agent_interactions (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          root_run_id TEXT NOT NULL,
          child_run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending-review', 'escalated', 'resolved')),
          created_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_main_agent_interactions_source
          ON main_agent_interactions(root_run_id, source_id, kind);
        CREATE INDEX IF NOT EXISTS idx_main_agent_interactions_pending
          ON main_agent_interactions(root_run_id, state, created_at ASC);
      `,
    },
    {
      version: 36,
      replaySafe: true,
      sql: `
        CREATE TABLE IF NOT EXISTS runtime_owner_leases (
          owner_epoch TEXT PRIMARY KEY,
          process_id INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          lease_expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_owner_leases_expiry
          ON runtime_owner_leases(lease_expires_at);
      `,
    },
    {
      version: 37,
      replaySafe: true,
      sql: `
        CREATE TABLE IF NOT EXISTS runtime_leader_lease (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          owner_epoch TEXT NOT NULL,
          process_id INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          lease_expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_leader_lease_expiry
          ON runtime_leader_lease(lease_expires_at);
      `,
    },
    {
      version: 38,
      replaySafe: true,
      sql: `
        CREATE TABLE IF NOT EXISTS model_protocol_capabilities (
          identity TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          base_url TEXT NOT NULL,
          model_id TEXT NOT NULL,
          native_tools_status TEXT NOT NULL
            CHECK(native_tools_status IN ('verified', 'unsupported')),
          successes INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          checked_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_model_protocol_capabilities_checked
          ON model_protocol_capabilities(checked_at DESC);
      `,
    },
    {
      version: 39,
      replaySafe: true,
      sql: `
        CREATE TABLE IF NOT EXISTS model_protocol_observations (
          identity TEXT NOT NULL,
          observation_scope TEXT NOT NULL,
          observation_kind TEXT NOT NULL
            CHECK(observation_kind IN ('verified', 'conclusive-failure', 'transient-failure')),
          reason TEXT,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY(identity, observation_scope)
        );
        CREATE INDEX IF NOT EXISTS idx_model_protocol_observations_recent
          ON model_protocol_observations(identity, observed_at DESC);
      `,
    },
    {
      version: 40,
      sql: `
        ALTER TABLE messages ADD COLUMN request_id TEXT;
        CREATE UNIQUE INDEX idx_messages_session_request_role
          ON messages(session_id, request_id, role)
          WHERE request_id IS NOT NULL;
      `,
    },
    {
      version: 41,
      sql: `
        CREATE TABLE session_commands_v41 (
          request_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          session_seq INTEGER NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL
            CHECK(state IN ('pending', 'processing', 'accepted', 'blocked', 'completed', 'failed', 'cancelled')),
          owner_token TEXT,
          owner_epoch TEXT,
          task_id TEXT UNIQUE,
          error TEXT,
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          completed_at INTEGER,
          UNIQUE(session_id, session_seq)
        );
        INSERT INTO session_commands_v41
          (request_id, session_id, session_seq, payload, state, owner_token,
           owner_epoch, task_id, error, created_at, claimed_at, completed_at)
        SELECT request_id, session_id, session_seq, payload, state, owner_token,
               owner_epoch, task_id, error, created_at, claimed_at, completed_at
        FROM session_commands;
        DROP TABLE session_commands;
        ALTER TABLE session_commands_v41 RENAME TO session_commands;
        CREATE INDEX idx_session_commands_head
          ON session_commands(session_id, state, session_seq ASC);
        CREATE INDEX idx_session_commands_task
          ON session_commands(task_id);
      `,
    },
    {
      version: 42,
      sql: `
        ALTER TABLE run_events
          ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      version: 43,
      replaySafe: true,
      sql: `
        CREATE TABLE IF NOT EXISTS token_usage_events (
          id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('agent', 'tool')),
          operation TEXT NOT NULL,
          segment INTEGER NOT NULL,
          step INTEGER NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_name TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL CHECK(source IN ('actual', 'estimated')),
          occurred_at INTEGER NOT NULL,
          local_day TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_token_usage_events_time
          ON token_usage_events(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_token_usage_events_session
          ON token_usage_events(session_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_token_usage_events_run
          ON token_usage_events(run_id, occurred_at ASC);

        CREATE TABLE IF NOT EXISTS token_usage_daily (
          local_day TEXT NOT NULL,
          scope_type TEXT NOT NULL CHECK(scope_type IN ('all', 'session')),
          scope_id TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          calls INTEGER NOT NULL DEFAULT 0,
          actual_calls INTEGER NOT NULL DEFAULT 0,
          estimated_calls INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(local_day, scope_type, scope_id)
        );
        CREATE INDEX IF NOT EXISTS idx_token_usage_daily_scope
          ON token_usage_daily(scope_type, scope_id, local_day ASC);
      `,
    },
    {
      version: 44,
      replaySafe: true,
      sql: "SELECT 1;",
    },
    // Versions 44-50 were published by the retired Claim/evidence runtime.
    // Keep their numbers reserved so databases created by that lineage can be
    // opened by the lightweight runtime without replaying obsolete tables.
    {
      version: 45,
      replaySafe: true,
      sql: "SELECT 1;",
    },
    {
      version: 46,
      replaySafe: true,
      sql: "SELECT 1;",
    },
    {
      version: 47,
      replaySafe: true,
      sql: "SELECT 1;",
    },
    {
      version: 48,
      replaySafe: true,
      sql: "SELECT 1;",
    },
    {
      version: 49,
      replaySafe: true,
      sql: "SELECT 1;",
    },
    {
      version: 50,
      replaySafe: true,
      sql: "SELECT 1;",
    },
    {
      version: 51,
      replaySafe: true,
      sql: `
        UPDATE run_graph_nodes
        SET status = 'completed'
        WHERE status = 'accepted';
      `,
    },
    {
      version: 52,
      sql: `
        UPDATE task_runs
        SET status = 'interrupted',
            error = COALESCE(error, 'Legacy semantic acceptance lifecycle was retired')
        WHERE status IN ('waiting-review', 'revision-required');

        UPDATE run_graph_nodes
        SET status = 'interrupted'
        WHERE status IN ('waiting-review', 'revision-required');

        UPDATE workflow_nodes
        SET status = 'failed',
            error = COALESCE(error, 'Legacy semantic acceptance lifecycle was retired')
        WHERE status IN ('waiting-review', 'revision-required');

        DROP TABLE IF EXISTS run_disagreements;
        DROP TABLE IF EXISTS run_claims;
        DROP TABLE IF EXISTS run_inferences;
      `,
    },
    {
      version: 53,
      sql: `
        ALTER TABLE main_agent_interactions RENAME TO main_agent_interactions_v35;
        CREATE TABLE main_agent_interactions (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          root_run_id TEXT NOT NULL,
          child_run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending', 'escalated', 'resolved')),
          created_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        INSERT INTO main_agent_interactions
          (id, source_id, root_run_id, child_run_id, session_id, kind, payload,
           state, created_at, resolved_at)
        SELECT id, source_id, root_run_id, child_run_id, session_id, kind, payload,
               CASE WHEN state = 'pending-review' THEN 'pending' ELSE state END,
               created_at, resolved_at
        FROM main_agent_interactions_v35;
        DROP TABLE main_agent_interactions_v35;
        CREATE UNIQUE INDEX idx_main_agent_interactions_source
          ON main_agent_interactions(root_run_id, source_id, kind);
        CREATE INDEX idx_main_agent_interactions_pending
          ON main_agent_interactions(root_run_id, state, created_at ASC);
      `,
    },
    {
      version: 54,
      // Old databases may still carry unused arbitration/review columns while
      // fresh lightweight databases never created them. SQLite has no portable
      // DROP COLUMN IF EXISTS, and retaining ignored columns is safer than
      // rebuilding a durable table during startup.
      replaySafe: true,
      sql: "SELECT 1;",
    },
    {
      version: 55,
      replaySafe: true,
      sql: `
        CREATE TABLE IF NOT EXISTS run_guidance (
          request_id TEXT PRIMARY KEY,
          root_run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message TEXT NOT NULL,
          attachments TEXT NOT NULL DEFAULT '[]',
          state TEXT NOT NULL CHECK(state IN ('pending', 'applied', 'rejected')),
          error TEXT,
          created_at INTEGER NOT NULL,
          applied_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_run_guidance_pending
          ON run_guidance(root_run_id, state, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_run_guidance_session
          ON run_guidance(session_id, created_at ASC);
      `,
    },
  ]

  applyMigrations(db, migrations)
}

export function closeDb() {
  _db?.close()
  _db = null
}

function isDatabaseBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown; errno?: unknown }
  return candidate.code === "SQLITE_BUSY"
    || candidate.code === "SQLITE_LOCKED"
    || candidate.errno === 5
    || candidate.errno === 6
}
