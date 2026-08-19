use crate::credentials::CredentialSyncResult;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const AUDIT_FILE: &str = "security_audit.json";
const MAX_ENTRIES: usize = 500;
static AUDIT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityAuditEntry {
    pub id: String,
    pub event: String,
    pub status: String,
    pub detail: String,
    pub created_at: u64,
}

pub fn record_credential_result(event: &str, result: &Result<CredentialSyncResult, String>) {
    let (status, detail) = match result {
        Ok(value) => ("success", format!("已保护 {} 项凭据", value.configured)),
        Err(_) => ("failed", "操作未完成，未记录错误参数".to_string()),
    };
    append(SecurityAuditEntry {
        id: uuid::Uuid::new_v4().to_string(),
        event: event.to_string(),
        status: status.to_string(),
        detail,
        created_at: now_ms(),
    });
}

pub fn list(limit: Option<usize>) -> Vec<SecurityAuditEntry> {
    let _guard = AUDIT_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let count = limit.unwrap_or(20).clamp(1, 100);
    let mut entries = read_entries();
    entries.reverse();
    entries.truncate(count);
    entries
}

fn append(entry: SecurityAuditEntry) {
    let _guard = AUDIT_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut entries = read_entries();
    entries.push(entry);
    if entries.len() > MAX_ENTRIES {
        entries.drain(0..entries.len() - MAX_ENTRIES);
    }
    if let Err(error) = write_entries(&entries) {
        eprintln!("[security-audit] 无法写入安全审计记录: {error}");
    }
}

fn read_entries() -> Vec<SecurityAuditEntry> {
    fs::read_to_string(audit_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_entries(entries: &[SecurityAuditEntry]) -> Result<(), String> {
    let path = audit_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let data = serde_json::to_string_pretty(entries).map_err(|error| error.to_string())? + "\n";
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        replace_file(&temporary, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &PathBuf, destination: &PathBuf) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let replacement = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &PathBuf, destination: &PathBuf) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

fn audit_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".eval").join(AUDIT_FILE)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::list;

    #[test]
    fn audit_list_limits_are_bounded() {
        assert!(list(Some(0)).len() <= 1);
        assert!(list(Some(1_000)).len() <= 100);
    }
}
