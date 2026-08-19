use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const CONFIG_FILE: &str = "eval_config.json";
const INDEX_FILE: &str = "credential_models.json";
const MCP_INDEX_FILE: &str = "credential_mcp.json";
const MODEL_TARGET_PREFIX: &str = "Eval/model/";
const MCP_TARGET_PREFIX: &str = "Eval/mcp/";
pub(crate) const WEBHOOK_TARGET: &str = "Eval/workflow-webhook/default";
pub(crate) const ACCOUNT_TOKEN_TARGET: &str = "Eval/account/session";
const MAX_MODELS: usize = 100;
const MAX_MCP_SERVERS: usize = 50;
const MAX_SECRET_BYTES: usize = 2_048;

pub fn save_account_token(token: &str) -> Result<(), String> {
    #[cfg(not(windows))]
    return Err("当前平台尚未提供系统凭据存储".into());

    #[cfg(windows)]
    {
        let valid = token.starts_with("eval_dt_")
            && (48..=128).contains(&token.len())
            && token
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-');
        if !valid {
            return Err("账号登录凭据格式无效".into());
        }
        write_named_secret(ACCOUNT_TOKEN_TARGET, token)
    }
}

pub fn read_account_token() -> Result<Option<String>, String> {
    #[cfg(not(windows))]
    return Ok(None);

    #[cfg(windows)]
    read_named_secret(ACCOUNT_TOKEN_TARGET)
}

pub fn delete_account_token() -> Result<(), String> {
    #[cfg(not(windows))]
    return Ok(());

    #[cfg(windows)]
    delete_named_secret(ACCOUNT_TOKEN_TARGET)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCredentialInput {
    pub id: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub clear: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSyncResult {
    pub backend: &'static str,
    pub configured: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialHealth {
    pub backend: &'static str,
    pub available: bool,
    pub healthy: bool,
    pub model_records: usize,
    pub model_credentials: usize,
    pub mcp_expected: usize,
    pub mcp_credentials: usize,
    pub mcp_missing: usize,
    pub webhook_configured: bool,
    pub read_errors: usize,
    pub rotation_days: u64,
    pub rotation_due: usize,
    pub oldest_credential_at: Option<u64>,
    pub newest_credential_at: Option<u64>,
    pub checked_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct McpCredentialInput {
    pub id: String,
    pub env: Option<BTreeMap<String, String>>,
    pub headers: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct McpCredentialKeys {
    pub env: BTreeSet<String>,
    pub headers: BTreeSet<String>,
}

pub(crate) type McpCredentialIndex = BTreeMap<String, McpCredentialKeys>;

#[derive(Debug, Default)]
pub struct CredentialSnapshot {
    model_index: BTreeSet<String>,
    model_values: BTreeMap<String, Option<String>>,
    mcp_index: McpCredentialIndex,
    mcp_values: BTreeMap<String, Option<String>>,
    webhook_value: Option<String>,
}

pub fn capture_credential_snapshot() -> Result<CredentialSnapshot, String> {
    #[cfg(not(windows))]
    return Err("当前平台尚未提供系统凭据存储".into());

    #[cfg(windows)]
    {
        let model_index = read_index();
        let mut model_values = BTreeMap::new();
        for id in &model_index {
            model_values.insert(id.clone(), read_secret(id)?);
        }
        let mcp_index = read_mcp_index();
        let mut mcp_values = BTreeMap::new();
        for (id, keys) in &mcp_index {
            for key in &keys.env {
                let target = mcp_target(id, "env", key);
                mcp_values.insert(target.clone(), read_named_secret(&target)?);
            }
            for key in &keys.headers {
                let target = mcp_target(id, "header", key);
                mcp_values.insert(target.clone(), read_named_secret(&target)?);
            }
        }
        Ok(CredentialSnapshot {
            model_index,
            model_values,
            mcp_index,
            mcp_values,
            webhook_value: read_named_secret(WEBHOOK_TARGET)?,
        })
    }
}

pub fn restore_credential_snapshot(snapshot: &CredentialSnapshot) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = snapshot;
        return Err("当前平台尚未提供系统凭据存储".into());
    }

    #[cfg(windows)]
    {
        let current_models = read_index();
        let touched_models = current_models
            .union(&snapshot.model_index)
            .cloned()
            .collect::<BTreeSet<_>>();
        restore_model_credentials(
            &touched_models,
            &snapshot.model_values,
            &snapshot.model_index,
        )?;

        let current_mcp = read_mcp_index();
        let mut touched_mcp = snapshot.mcp_values.keys().cloned().collect::<BTreeSet<_>>();
        for (id, keys) in &current_mcp {
            for key in &keys.env {
                touched_mcp.insert(mcp_target(id, "env", key));
            }
            for key in &keys.headers {
                touched_mcp.insert(mcp_target(id, "header", key));
            }
        }
        restore_mcp_credentials(&touched_mcp, &snapshot.mcp_values, &snapshot.mcp_index)?;
        restore_named_secret(WEBHOOK_TARGET, snapshot.webhook_value.as_deref())
    }
}

pub fn prepare_model_credentials() -> BTreeMap<String, String> {
    #[cfg(not(windows))]
    return BTreeMap::new();

    #[cfg(windows)]
    {
        let path = eval_dir().join(CONFIG_FILE);
        let Ok(text) = fs::read_to_string(&path) else {
            return BTreeMap::new();
        };
        let Ok(mut root) = serde_json::from_str::<Value>(&text) else {
            eprintln!("[credentials] 无法解析模型配置，已跳过凭据迁移");
            return BTreeMap::new();
        };
        let Some(models) = model_array_mut(&mut root) else {
            return BTreeMap::new();
        };

        let mut ids = BTreeSet::new();
        let mut secrets = BTreeMap::new();
        let mut changed = false;
        for model in models {
            let Some(object) = model.as_object_mut() else {
                continue;
            };
            let Some(id) = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_id(id))
            else {
                continue;
            };
            let id = id.to_string();
            ids.insert(id.clone());
            let inline = object.get("apiKey").and_then(Value::as_str).unwrap_or("");
            if !inline.is_empty() {
                match write_secret(&id, inline) {
                    Ok(()) => {
                        secrets.insert(id, inline.to_string());
                        object.insert("apiKey".into(), Value::String(String::new()));
                        changed = true;
                    }
                    Err(error) => eprintln!("[credentials] 迁移模型 {id} 的密钥失败: {error}"),
                }
            } else if let Ok(Some(secret)) = read_secret(&id) {
                secrets.insert(id, secret);
            }
        }

        if changed {
            if let Err(error) = write_json(&path, &root) {
                eprintln!("[credentials] 更新脱敏模型配置失败: {error}");
            }
        }
        if let Err(error) = write_index(&ids) {
            eprintln!("[credentials] 更新凭据索引失败: {error}");
        }
        secrets
    }
}

pub fn sync_model_credentials(
    models: Vec<ModelCredentialInput>,
) -> Result<CredentialSyncResult, String> {
    #[cfg(not(windows))]
    {
        let _ = models;
        return Err("当前平台尚未提供系统凭据存储".into());
    }

    #[cfg(windows)]
    {
        if models.len() > MAX_MODELS {
            return Err(format!("模型数量不能超过 {MAX_MODELS}"));
        }
        let mut retained = BTreeSet::new();
        for model in &models {
            if !valid_id(&model.id) || !retained.insert(model.id.clone()) {
                return Err("模型 ID 无效或重复".into());
            }
            if model.api_key.as_bytes().len() > MAX_SECRET_BYTES {
                return Err(format!("模型 {} 的密钥过长", model.id));
            }
        }

        let previous_index = read_index();
        let touched = previous_index
            .union(&retained)
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut previous = BTreeMap::new();
        for id in &touched {
            previous.insert(id.clone(), read_secret(id)?);
        }
        let result = (|| -> Result<(), String> {
            for model in &models {
                if model.clear {
                    delete_secret(&model.id)?;
                } else if !model.api_key.is_empty() {
                    write_secret(&model.id, &model.api_key)?;
                }
            }
            for removed in previous_index.difference(&retained) {
                delete_secret(removed)?;
            }
            write_index(&retained)
        })();
        if let Err(error) = result {
            let rollback = restore_model_credentials(&touched, &previous, &previous_index);
            return Err(with_rollback_error(error, rollback));
        }
        let configured = retained
            .iter()
            .filter(|id| matches!(read_secret(id), Ok(Some(_))))
            .count();
        Ok(CredentialSyncResult {
            backend: "windows-credential-manager",
            configured,
        })
    }
}

pub fn sync_mcp_credentials(
    servers: Vec<McpCredentialInput>,
) -> Result<CredentialSyncResult, String> {
    #[cfg(not(windows))]
    {
        let _ = servers;
        return Err("当前平台尚未提供系统凭据存储".into());
    }

    #[cfg(windows)]
    {
        validate_mcp_inputs(&servers)?;
        let previous = read_mcp_index();
        let retained = servers
            .iter()
            .map(|server| server.id.clone())
            .collect::<BTreeSet<_>>();
        let targets = mcp_targets_for_snapshot(&previous, &servers);
        let mut previous_values = BTreeMap::new();
        for target in &targets {
            previous_values.insert(target.clone(), read_named_secret(target)?);
        }
        let result = (|| -> Result<McpCredentialIndex, String> {
            for (id, keys) in &previous {
                if !retained.contains(id) {
                    delete_mcp_group(id, keys)?;
                }
            }

            let mut next = McpCredentialIndex::new();
            for server in &servers {
                let current = previous.get(&server.id).cloned().unwrap_or_default();
                let env = sync_mcp_kind(&server.id, "env", server.env.as_ref(), &current.env)?;
                let headers = sync_mcp_kind(
                    &server.id,
                    "header",
                    server.headers.as_ref(),
                    &current.headers,
                )?;
                next.insert(server.id.clone(), McpCredentialKeys { env, headers });
            }
            write_mcp_index(&next)?;
            Ok(next)
        })();
        let next = match result {
            Ok(next) => next,
            Err(error) => {
                let rollback = restore_mcp_credentials(&targets, &previous_values, &previous);
                return Err(with_rollback_error(error, rollback));
            }
        };
        let configured = next
            .values()
            .map(|keys| keys.env.len() + keys.headers.len())
            .sum();
        Ok(CredentialSyncResult {
            backend: "windows-credential-manager",
            configured,
        })
    }
}

pub fn sync_workflow_webhook_credential(
    secret: String,
    clear: bool,
) -> Result<CredentialSyncResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (secret, clear);
        return Err("当前平台尚未提供系统凭据存储".into());
    }

    #[cfg(windows)]
    {
        if secret.as_bytes().len() > MAX_SECRET_BYTES {
            return Err("Webhook 密钥过长".into());
        }
        let previous = read_named_secret(WEBHOOK_TARGET)?;
        let result = if clear {
            delete_named_secret(WEBHOOK_TARGET)
        } else if !secret.is_empty() {
            write_named_secret(WEBHOOK_TARGET, &secret)
        } else {
            Ok(())
        };
        if let Err(error) = result {
            let rollback = restore_named_secret(WEBHOOK_TARGET, previous.as_deref());
            return Err(with_rollback_error(error, rollback));
        }
        let configured = usize::from(matches!(read_named_secret(WEBHOOK_TARGET), Ok(Some(_))));
        Ok(CredentialSyncResult {
            backend: "windows-credential-manager",
            configured,
        })
    }
}

pub fn credential_health(rotation_days: Option<u64>) -> CredentialHealth {
    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let rotation_days = rotation_days.unwrap_or(90).clamp(1, 3_650);

    #[cfg(not(windows))]
    return CredentialHealth {
        backend: "unavailable",
        available: false,
        healthy: false,
        model_records: 0,
        model_credentials: 0,
        mcp_expected: 0,
        mcp_credentials: 0,
        mcp_missing: 0,
        webhook_configured: false,
        read_errors: 0,
        rotation_days,
        rotation_due: 0,
        oldest_credential_at: None,
        newest_credential_at: None,
        checked_at,
    };

    #[cfg(windows)]
    {
        let model_ids = read_index();
        let mut model_credentials = 0;
        let mut read_errors = 0;
        let mut timestamps = Vec::new();
        for id in &model_ids {
            match read_secret(id) {
                Ok(Some(_)) => {
                    model_credentials += 1;
                    inspect_timestamp(&credential_target(id), &mut timestamps, &mut read_errors);
                }
                Ok(None) => {}
                Err(_) => read_errors += 1,
            }
        }

        let mcp_index = read_mcp_index();
        let mcp_expected = mcp_index
            .values()
            .map(|keys| keys.env.len() + keys.headers.len())
            .sum();
        let mut mcp_credentials = 0;
        let mut mcp_missing = 0;
        for (id, keys) in &mcp_index {
            for key in &keys.env {
                inspect_named_credential(
                    &mcp_target(id, "env", key),
                    &mut mcp_credentials,
                    &mut mcp_missing,
                    &mut read_errors,
                    &mut timestamps,
                );
            }
            for key in &keys.headers {
                inspect_named_credential(
                    &mcp_target(id, "header", key),
                    &mut mcp_credentials,
                    &mut mcp_missing,
                    &mut read_errors,
                    &mut timestamps,
                );
            }
        }
        let webhook_configured = match read_named_secret(WEBHOOK_TARGET) {
            Ok(Some(_)) => {
                inspect_timestamp(
                    &wide_target(WEBHOOK_TARGET),
                    &mut timestamps,
                    &mut read_errors,
                );
                true
            }
            Ok(None) => false,
            Err(_) => {
                read_errors += 1;
                false
            }
        };

        let rotation_threshold = checked_at.saturating_sub(
            rotation_days
                .saturating_mul(24)
                .saturating_mul(60)
                .saturating_mul(60)
                .saturating_mul(1_000),
        );
        let rotation_due = timestamps
            .iter()
            .filter(|timestamp| **timestamp <= rotation_threshold)
            .count();
        let oldest_credential_at = timestamps.iter().min().copied();
        let newest_credential_at = timestamps.iter().max().copied();

        CredentialHealth {
            backend: "windows-credential-manager",
            available: true,
            healthy: mcp_missing == 0 && read_errors == 0,
            model_records: model_ids.len(),
            model_credentials,
            mcp_expected,
            mcp_credentials,
            mcp_missing,
            webhook_configured,
            read_errors,
            rotation_days,
            rotation_due,
            oldest_credential_at,
            newest_credential_at,
            checked_at,
        }
    }
}

#[cfg(windows)]
fn inspect_named_credential(
    target: &str,
    configured: &mut usize,
    missing: &mut usize,
    errors: &mut usize,
    timestamps: &mut Vec<u64>,
) {
    match read_named_secret(target) {
        Ok(Some(_)) => {
            *configured += 1;
            inspect_timestamp(&wide_target(target), timestamps, errors);
        }
        Ok(None) => *missing += 1,
        Err(_) => {
            *missing += 1;
            *errors += 1;
        }
    }
}

#[cfg(windows)]
fn inspect_timestamp(target: &[u16], timestamps: &mut Vec<u64>, errors: &mut usize) {
    match windows_credentials::last_written(target) {
        Ok(Some(timestamp)) => timestamps.push(timestamp),
        Ok(None) => {}
        Err(_) => *errors += 1,
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_mcp_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(valid_name_byte)
}

fn valid_secret_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 100 && key.bytes().all(valid_name_byte)
}

fn valid_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

#[cfg(windows)]
fn restore_model_credentials(
    touched: &BTreeSet<String>,
    previous: &BTreeMap<String, Option<String>>,
    previous_index: &BTreeSet<String>,
) -> Result<(), String> {
    for id in touched {
        delete_secret(id)?;
        if let Some(secret) = previous.get(id).and_then(Option::as_deref) {
            write_secret(id, secret)?;
        }
    }
    write_index(previous_index)
}

#[cfg(windows)]
fn mcp_targets_for_snapshot(
    previous: &McpCredentialIndex,
    servers: &[McpCredentialInput],
) -> BTreeSet<String> {
    let mut targets = BTreeSet::new();
    for (id, keys) in previous {
        for key in &keys.env {
            targets.insert(mcp_target(id, "env", key));
        }
        for key in &keys.headers {
            targets.insert(mcp_target(id, "header", key));
        }
    }
    for server in servers {
        for key in server
            .env
            .as_ref()
            .into_iter()
            .flat_map(|values| values.keys())
        {
            targets.insert(mcp_target(&server.id, "env", key));
        }
        for key in server
            .headers
            .as_ref()
            .into_iter()
            .flat_map(|values| values.keys())
        {
            targets.insert(mcp_target(&server.id, "header", key));
        }
    }
    targets
}

#[cfg(windows)]
fn restore_mcp_credentials(
    targets: &BTreeSet<String>,
    previous_values: &BTreeMap<String, Option<String>>,
    previous_index: &McpCredentialIndex,
) -> Result<(), String> {
    for target in targets {
        restore_named_secret(
            target,
            previous_values.get(target).and_then(Option::as_deref),
        )?;
    }
    write_mcp_index(previous_index)
}

#[cfg(windows)]
fn restore_named_secret(target: &str, previous: Option<&str>) -> Result<(), String> {
    delete_named_secret(target)?;
    if let Some(secret) = previous {
        write_named_secret(target, secret)?;
    }
    Ok(())
}

#[cfg(windows)]
fn with_rollback_error(error: String, rollback: Result<(), String>) -> String {
    match rollback {
        Ok(()) => error,
        Err(rollback_error) => format!("{error}; 回滚凭据失败: {rollback_error}"),
    }
}

fn eval_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".eval")
}

fn model_array_mut(root: &mut Value) -> Option<&mut Vec<Value>> {
    if root.is_array() {
        root.as_array_mut()
    } else {
        root.get_mut("models").and_then(Value::as_array_mut)
    }
}

fn read_index() -> BTreeSet<String> {
    fs::read_to_string(eval_dir().join(INDEX_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|id| valid_id(id))
        .collect()
}

fn write_index(ids: &BTreeSet<String>) -> Result<(), String> {
    let value = ids.iter().cloned().collect::<Vec<_>>();
    write_json(&eval_dir().join(INDEX_FILE), &value)
}

pub(crate) fn read_mcp_index() -> McpCredentialIndex {
    fs::read_to_string(eval_dir().join(MCP_INDEX_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn write_mcp_index(index: &McpCredentialIndex) -> Result<(), String> {
    write_json(&eval_dir().join(MCP_INDEX_FILE), index)
}

fn write_json(path: &PathBuf, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let data = serde_json::to_string_pretty(value).map_err(|error| error.to_string())? + "\n";
    fs::write(path, data).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn credential_target(id: &str) -> Vec<u16> {
    wide_target(&format!("{MODEL_TARGET_PREFIX}{id}"))
}

#[cfg(windows)]
fn write_secret(id: &str, secret: &str) -> Result<(), String> {
    windows_credentials::write(&credential_target(id), secret.as_bytes())
}

#[cfg(windows)]
fn read_secret(id: &str) -> Result<Option<String>, String> {
    windows_credentials::read(&credential_target(id))?
        .map(|bytes| String::from_utf8(bytes).map_err(|_| "系统凭据不是有效 UTF-8".to_string()))
        .transpose()
}

#[cfg(windows)]
fn delete_secret(id: &str) -> Result<(), String> {
    windows_credentials::delete(&credential_target(id))
}

#[cfg(windows)]
pub(crate) fn write_named_secret(target: &str, secret: &str) -> Result<(), String> {
    if secret.as_bytes().len() > MAX_SECRET_BYTES {
        return Err("系统凭据值过长".into());
    }
    windows_credentials::write(&wide_target(target), secret.as_bytes())
}

#[cfg(windows)]
pub(crate) fn read_named_secret(target: &str) -> Result<Option<String>, String> {
    windows_credentials::read(&wide_target(target))?
        .map(|bytes| String::from_utf8(bytes).map_err(|_| "系统凭据不是有效 UTF-8".to_string()))
        .transpose()
}

#[cfg(windows)]
pub(crate) fn delete_named_secret(target: &str) -> Result<(), String> {
    windows_credentials::delete(&wide_target(target))
}

#[cfg(windows)]
pub(crate) fn mcp_target(id: &str, kind: &str, key: &str) -> String {
    format!("{MCP_TARGET_PREFIX}{id}/{kind}/{key}")
}

#[cfg(windows)]
fn wide_target(target: &str) -> Vec<u16> {
    target.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
fn validate_mcp_inputs(servers: &[McpCredentialInput]) -> Result<(), String> {
    if servers.len() > MAX_MCP_SERVERS {
        return Err(format!("MCP 服务数量不能超过 {MAX_MCP_SERVERS}"));
    }
    let mut ids = BTreeSet::new();
    for server in servers {
        if !valid_mcp_id(&server.id) || !ids.insert(server.id.clone()) {
            return Err("MCP 服务 ID 无效或重复".into());
        }
        for values in [server.env.as_ref(), server.headers.as_ref()]
            .into_iter()
            .flatten()
        {
            if values.len() > 100 {
                return Err(format!("MCP 服务 {} 的凭据项过多", server.id));
            }
            for (key, value) in values {
                if !valid_secret_key(key) || value.as_bytes().len() > MAX_SECRET_BYTES {
                    return Err(format!("MCP 服务 {} 的凭据键或值无效", server.id));
                }
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn sync_mcp_kind(
    id: &str,
    kind: &str,
    incoming: Option<&BTreeMap<String, String>>,
    current: &BTreeSet<String>,
) -> Result<BTreeSet<String>, String> {
    let Some(values) = incoming else {
        return Ok(current.clone());
    };
    let retained = values
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>();
    for removed in current.difference(&retained) {
        delete_named_secret(&mcp_target(id, kind, removed))?;
    }
    for (key, value) in values.iter().filter(|(_, value)| !value.is_empty()) {
        write_named_secret(&mcp_target(id, kind, key), value)?;
    }
    Ok(retained)
}

#[cfg(windows)]
fn delete_mcp_group(id: &str, keys: &McpCredentialKeys) -> Result<(), String> {
    for key in &keys.env {
        delete_named_secret(&mcp_target(id, "env", key))?;
    }
    for key in &keys.headers {
        delete_named_secret(&mcp_target(id, "header", key))?;
    }
    Ok(())
}

#[cfg(windows)]
mod windows_credentials {
    use std::ffi::c_void;
    use std::ptr;

    const CRED_TYPE_GENERIC: u32 = 1;
    const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;
    const ERROR_NOT_FOUND: i32 = 1168;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct CredentialW {
        flags: u32,
        kind: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: FileTime,
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "Advapi32")]
    extern "system" {
        fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
        fn CredReadW(
            target: *const u16,
            kind: u32,
            flags: u32,
            credential: *mut *mut CredentialW,
        ) -> i32;
        fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
        fn CredFree(buffer: *mut c_void);
    }

    pub fn write(target: &[u16], secret: &[u8]) -> Result<(), String> {
        let mut username: Vec<u16> = "Eval".encode_utf16().chain(Some(0)).collect();
        let credential = CredentialW {
            flags: 0,
            kind: CRED_TYPE_GENERIC,
            target_name: target.as_ptr() as *mut u16,
            comment: ptr::null_mut(),
            last_written: FileTime { low: 0, high: 0 },
            credential_blob_size: secret.len() as u32,
            credential_blob: secret.as_ptr() as *mut u8,
            persist: CRED_PERSIST_LOCAL_MACHINE,
            attribute_count: 0,
            attributes: ptr::null_mut(),
            target_alias: ptr::null_mut(),
            user_name: username.as_mut_ptr(),
        };
        let ok = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 {
            Err(last_error("写入"))
        } else {
            Ok(())
        }
    }

    pub fn read(target: &[u16]) -> Result<Option<Vec<u8>>, String> {
        let mut raw: *mut CredentialW = ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_NOT_FOUND) {
                Ok(None)
            } else {
                Err(format!("读取系统凭据失败: {error}"))
            };
        }
        let bytes = unsafe {
            let credential = &*raw;
            let value = std::slice::from_raw_parts(
                credential.credential_blob,
                credential.credential_blob_size as usize,
            )
            .to_vec();
            CredFree(raw as *mut c_void);
            value
        };
        Ok(Some(bytes))
    }

    pub fn last_written(target: &[u16]) -> Result<Option<u64>, String> {
        let mut raw: *mut CredentialW = ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_NOT_FOUND) {
                Ok(None)
            } else {
                Err(format!("读取系统凭据元数据失败: {error}"))
            };
        }
        let timestamp = unsafe {
            let credential = &*raw;
            let value = filetime_to_unix_ms(&credential.last_written);
            CredFree(raw as *mut c_void);
            value
        };
        Ok(timestamp)
    }

    pub fn delete(target: &[u16]) -> Result<(), String> {
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NOT_FOUND) {
            Ok(())
        } else {
            Err(format!("删除系统凭据失败: {error}"))
        }
    }

    fn last_error(action: &str) -> String {
        format!("{action}系统凭据失败: {}", std::io::Error::last_os_error())
    }

    fn filetime_to_unix_ms(value: &FileTime) -> Option<u64> {
        const WINDOWS_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
        let ticks = ((value.high as u64) << 32) | value.low as u64;
        ticks
            .checked_sub(WINDOWS_EPOCH_TICKS)
            .map(|elapsed| elapsed / 10_000)
    }

    #[cfg(test)]
    mod tests {
        use super::{filetime_to_unix_ms, FileTime};

        #[test]
        fn converts_windows_filetime_to_unix_milliseconds() {
            let ticks = 116_444_736_010_000_000_u64;
            let value = FileTime {
                low: ticks as u32,
                high: (ticks >> 32) as u32,
            };
            assert_eq!(filetime_to_unix_ms(&value), Some(1_000));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{valid_id, valid_mcp_id, valid_secret_key};

    #[test]
    fn credential_ids_are_strictly_scoped() {
        assert!(valid_id("openai-main_1"));
        assert!(!valid_id("../other"));
        assert!(!valid_id("model/other"));
        assert!(!valid_id(""));
        assert!(valid_mcp_id("github-server"));
        assert!(valid_secret_key("Authorization"));
        assert!(!valid_secret_key("bad/header"));
    }
}
