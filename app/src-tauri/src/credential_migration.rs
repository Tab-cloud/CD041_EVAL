use crate::credentials::{
    mcp_target, read_named_secret, write_mcp_index, write_named_secret, McpCredentialIndex,
    McpCredentialKeys, WEBHOOK_TARGET,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const MCP_CONFIG_KEY: &str = "mcp.servers";

#[derive(Debug, Default, Serialize)]
pub struct McpCredentialValues {
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Default)]
pub struct PreparedDatabaseCredentials {
    pub mcp: BTreeMap<String, McpCredentialValues>,
    pub workflow_webhook: String,
}

pub fn prepare_database_credentials() -> PreparedDatabaseCredentials {
    #[cfg(not(windows))]
    return PreparedDatabaseCredentials::default();

    #[cfg(windows)]
    {
        let path = eval_dir().join("eval.db");
        if !path.exists() {
            return PreparedDatabaseCredentials::default();
        }
        let Ok(connection) = Connection::open(path) else {
            eprintln!("[credentials] 无法打开 Eval 数据库，已跳过数据库凭据迁移");
            return PreparedDatabaseCredentials::default();
        };
        if let Err(error) =
            connection.execute_batch("PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;")
        {
            eprintln!("[credentials] 无法启用 SQLite 安全删除: {error}");
        }
        let prepared = PreparedDatabaseCredentials {
            mcp: migrate_mcp(&connection),
            workflow_webhook: migrate_workflow_webhook(&connection),
        };
        if let Err(error) = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
            eprintln!("[credentials] 无法截断旧 SQLite WAL: {error}");
        }
        prepared
    }
}

#[cfg(windows)]
fn migrate_mcp(connection: &Connection) -> BTreeMap<String, McpCredentialValues> {
    let raw = connection
        .query_row(
            "SELECT value FROM config WHERE key = ?1",
            [MCP_CONFIG_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(raw) = raw else {
        return BTreeMap::new();
    };
    let Ok(mut servers) = serde_json::from_str::<Value>(&raw) else {
        eprintln!("[credentials] MCP 配置格式无效，已跳过凭据迁移");
        return BTreeMap::new();
    };
    let Some(items) = servers.as_array_mut() else {
        return BTreeMap::new();
    };

    let mut values = BTreeMap::new();
    let mut index = McpCredentialIndex::new();
    let mut changed = false;
    for item in items {
        let Some(server) = item.as_object_mut() else {
            continue;
        };
        let Some(id) = server
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_name(id, 100))
        else {
            continue;
        };
        let id = id.to_string();
        let mut server_values = McpCredentialValues::default();
        let env = migrate_record(&id, "env", server.get_mut("env"), &mut changed);
        let headers = migrate_record(&id, "header", server.get_mut("headers"), &mut changed);
        server_values.env = env.0;
        server_values.headers = headers.0;
        index.insert(
            id.clone(),
            McpCredentialKeys {
                env: env.1,
                headers: headers.1,
            },
        );
        values.insert(id, server_values);
    }

    if changed {
        if let Ok(redacted) = serde_json::to_string(&servers) {
            if let Err(error) = connection.execute(
                "UPDATE config SET value = ?1 WHERE key = ?2",
                (&redacted, MCP_CONFIG_KEY),
            ) {
                eprintln!("[credentials] 更新脱敏 MCP 配置失败: {error}");
            }
        }
    }
    if let Err(error) = write_mcp_index(&index) {
        eprintln!("[credentials] 更新 MCP 凭据索引失败: {error}");
    }
    values
}

#[cfg(windows)]
fn migrate_record(
    id: &str,
    kind: &str,
    value: Option<&mut Value>,
    changed: &mut bool,
) -> (BTreeMap<String, String>, BTreeSet<String>) {
    let mut values = BTreeMap::new();
    let mut keys = BTreeSet::new();
    let Some(record) = value.and_then(Value::as_object_mut) else {
        return (values, keys);
    };
    for (key, stored) in record {
        if !valid_name(key, 100) {
            continue;
        }
        let target = mcp_target(id, kind, key);
        let inline = stored.as_str().unwrap_or("");
        if !inline.is_empty() {
            match write_named_secret(&target, inline) {
                Ok(()) => {
                    values.insert(key.clone(), inline.to_string());
                    keys.insert(key.clone());
                    *stored = Value::String(String::new());
                    *changed = true;
                }
                Err(error) => eprintln!("[credentials] 迁移 MCP {id}/{key} 失败: {error}"),
            }
        } else if let Ok(Some(secret)) = read_named_secret(&target) {
            values.insert(key.clone(), secret);
            keys.insert(key.clone());
        }
    }
    (values, keys)
}

#[cfg(windows)]
fn migrate_workflow_webhook(connection: &Connection) -> String {
    let inline = connection
        .query_row(
            "SELECT secret FROM workflow_webhook_settings WHERE id = 'default'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or_default();
    if !inline.is_empty() {
        match write_named_secret(WEBHOOK_TARGET, &inline) {
            Ok(()) => {
                if let Err(error) = connection.execute(
                    "UPDATE workflow_webhook_settings SET secret = '' WHERE id = 'default'",
                    [],
                ) {
                    eprintln!("[credentials] 清理 Webhook 明文密钥失败: {error}");
                }
                return inline;
            }
            Err(error) => eprintln!("[credentials] 迁移 Webhook 密钥失败: {error}"),
        }
    }
    read_named_secret(WEBHOOK_TARGET)
        .ok()
        .flatten()
        .unwrap_or_default()
}

#[cfg(windows)]
fn valid_name(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn eval_dir() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".eval")
}
