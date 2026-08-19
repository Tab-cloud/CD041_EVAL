use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime::Receiver;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod credential_migration;
mod credentials;
mod security_audit;

pub struct AgentProcess {
    pid: Mutex<Option<u32>>,
    token: String,
    shutting_down: AtomicBool,
}

pub struct CredentialTransactions {
    pending: Mutex<HashMap<String, credentials::CredentialSnapshot>>,
}

pub struct TrayState {
    close_notice_shown: AtomicBool,
}

const RUNTIME_LEASE_GRACE_MS: u64 = 16_000;
const STABLE_RUNTIME_MS: u64 = 60_000;
const MAX_RUNTIME_LOG_BYTES: u64 = 5 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStageResult {
    transaction_id: String,
    backend: &'static str,
    configured: usize,
}

fn server_path(app: &tauri::AppHandle) -> PathBuf {
    let name = if cfg!(windows) {
        "eval-server.exe"
    } else {
        "eval-server"
    };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(name);
        if bundled.exists() {
            return bundled;
        }
    }
    if cfg!(debug_assertions) {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../eval-server")
            .join(name);
        if development.exists() {
            return development;
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

fn runtime_log_path(app: &tauri::AppHandle) -> PathBuf {
    std::env::var_os("EVAL_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_log_dir().ok())
        .unwrap_or_else(std::env::temp_dir)
        .join("desktop-sidecar.log")
}

fn append_runtime_log(app: &tauri::AppHandle, channel: &str, message: &str) {
    let path = runtime_log_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if path.metadata().map(|metadata| metadata.len()).unwrap_or(0) >= MAX_RUNTIME_LOG_BYTES {
        let backup = path.with_extension("log.1");
        let _ = fs::remove_file(&backup);
        let _ = fs::rename(&path, backup);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let normalized = message.replace(['\r', '\n'], " ");
        let _ = writeln!(file, "{timestamp} [{channel}] {}", normalized.trim());
    }
}

fn restart_attempt(previous_attempt: u32, uptime: Duration) -> u32 {
    if uptime >= Duration::from_millis(STABLE_RUNTIME_MS) {
        1
    } else {
        previous_attempt.saturating_add(1).max(1)
    }
}

fn restart_delay(attempt: u32) -> Duration {
    Duration::from_millis(match attempt {
        0 | 1 => RUNTIME_LEASE_GRACE_MS,
        2 => 20_000,
        3 => 30_000,
        _ => 60_000,
    })
}

async fn wait_for_restart(delay: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay)).await;
}

fn emit_agent_state(
    app: &tauri::AppHandle,
    state: &str,
    pid: Option<u32>,
    attempt: u32,
    retry_in_ms: Option<u64>,
    reason: Option<&str>,
) {
    let _ = app.emit(
        "agent://state",
        serde_json::json!({
            "state": state,
            "pid": pid,
            "attempt": attempt,
            "retryInMs": retry_in_ms,
            "reason": reason,
        }),
    );
}

fn spawn_agent_process(
    app: &tauri::AppHandle,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let path = server_path(app);
    if !path.exists() {
        return Err(format!("eval-server not found at {}", path.display()));
    }

    let token = app.state::<AgentProcess>().token.clone();
    let protocol_manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../runtime-protocol.json"))
            .map_err(|error| error.to_string())?;
    let protocol_version = protocol_manifest["version"]
        .as_u64()
        .ok_or_else(|| "runtime protocol version missing".to_string())?
        .to_string();
    let model_credentials = credentials::prepare_model_credentials();
    let database_credentials = credential_migration::prepare_database_credentials();
    let community_token = match credentials::read_account_token() {
        Ok(value) => value,
        Err(error) => {
            append_runtime_log(
                app,
                "credential",
                &format!("community credential unavailable: {error}"),
            );
            None
        }
    };
    let credential_payload = serde_json::json!({
        "models": model_credentials,
        "mcp": database_credentials.mcp,
        "workflowWebhook": database_credentials.workflow_webhook,
        "communityToken": community_token,
    })
    .to_string()
        + "\n";
    let (events, mut child) = app
        .shell()
        .command(path.to_string_lossy().to_string())
        .env("EVAL_AGENT_TOKEN", token)
        .env("EVAL_DESKTOP_PROTOCOL_VERSION", protocol_version)
        .env(
            "EVAL_CREDENTIAL_STORE",
            if cfg!(windows) { "external" } else { "file" },
        )
        .env("EVAL_CREDENTIAL_BOOTSTRAP", "stdin")
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Err(error) = child.write(credential_payload.as_bytes()) {
        let _ = child.kill();
        return Err(error.to_string());
    }
    Ok((events, child))
}

async fn supervise_agent_process(app: tauri::AppHandle, mut events: Receiver<CommandEvent>) {
    let mut started_at = Instant::now();
    let mut attempt = 0_u32;
    loop {
        let mut termination_reason = "event stream closed".to_string();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).into_owned();
                    append_runtime_log(&app, "stdout", &line);
                    let _ = app.emit("agent://stdout", line);
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).into_owned();
                    append_runtime_log(&app, "stderr", &line);
                    let _ = app.emit("agent://stderr", line);
                }
                CommandEvent::Terminated(payload) => {
                    termination_reason = format!(
                        "terminated code={:?} signal={:?}",
                        payload.code, payload.signal,
                    );
                    let _ = app.emit("agent://exit", payload.code);
                    break;
                }
                CommandEvent::Error(error) => {
                    termination_reason = format!("process event error: {error}");
                    let _ = app.emit("agent://error", error);
                    break;
                }
                _ => {}
            }
        }

        *app.state::<AgentProcess>().pid.lock().unwrap() = None;
        append_runtime_log(&app, "lifecycle", &termination_reason);
        if app
            .state::<AgentProcess>()
            .shutting_down
            .load(Ordering::SeqCst)
        {
            emit_agent_state(
                &app,
                "stopped",
                None,
                attempt,
                None,
                Some(&termination_reason),
            );
            return;
        }

        attempt = restart_attempt(attempt, started_at.elapsed());
        loop {
            let delay = restart_delay(attempt);
            emit_agent_state(
                &app,
                "restarting",
                None,
                attempt,
                Some(delay.as_millis() as u64),
                Some(&termination_reason),
            );
            append_runtime_log(
                &app,
                "lifecycle",
                &format!(
                    "restart attempt {attempt} scheduled in {} ms: {termination_reason}",
                    delay.as_millis(),
                ),
            );
            wait_for_restart(delay).await;
            if app
                .state::<AgentProcess>()
                .shutting_down
                .load(Ordering::SeqCst)
            {
                return;
            }

            match spawn_agent_process(&app) {
                Ok((next_events, child)) => {
                    let pid = child.pid();
                    *app.state::<AgentProcess>().pid.lock().unwrap() = Some(pid);
                    append_runtime_log(
                        &app,
                        "lifecycle",
                        &format!("eval-server restarted pid={pid} attempt={attempt}"),
                    );
                    emit_agent_state(&app, "running", Some(pid), attempt, None, None);
                    events = next_events;
                    started_at = Instant::now();
                    break;
                }
                Err(error) => {
                    termination_reason = format!("restart spawn failed: {error}");
                    append_runtime_log(&app, "lifecycle", &termination_reason);
                    let _ = app.emit("agent://error", termination_reason.clone());
                    attempt = attempt.saturating_add(1);
                }
            }
        }
    }
}

fn terminate_process(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;

        // Eval is built as a GUI application. Use PowerShell's native process
        // API because taskkill can fail with a misleading page-file error on
        // some Windows installations. CREATE_NO_WINDOW prevents a CLI flash.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let command = format!("Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue");
        let _ = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &command,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(windows))]
    let _ = std::process::Command::new("kill")
        .arg(pid.to_string())
        .status();
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn create_system_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示 Eval", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 Eval", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("eval-tray")
        .tooltip("Eval · AI Agent 正在后台运行")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[tauri::command]
fn get_agent_token(state: tauri::State<'_, AgentProcess>) -> String {
    state.token.clone()
}

#[tauri::command]
fn save_account_token(token: String) -> Result<(), String> {
    credentials::save_account_token(&token)
}

#[tauri::command]
fn read_account_token() -> Result<Option<String>, String> {
    credentials::read_account_token()
}

#[tauri::command]
fn delete_account_token() -> Result<(), String> {
    credentials::delete_account_token()
}

#[tauri::command]
fn open_account_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "账号登录地址无效".to_string())?;
    let production = parsed.scheme() == "https" && parsed.host_str() == Some("eval.zailink.space");
    let development = cfg!(debug_assertions)
        && parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1"));
    if !production && !development {
        return Err("只能打开受信任的 Eval 账号登录地址".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("账号登录地址不能包含内嵌凭据".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("无法打开系统浏览器: {error}"))
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "外部网页地址无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只能在系统浏览器中打开 HTTP 或 HTTPS 网页".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("外部网页地址不能包含内嵌凭据".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("无法打开系统浏览器: {error}"))
}

#[tauri::command]
fn sync_model_credentials(
    models: Vec<credentials::ModelCredentialInput>,
    state: tauri::State<'_, CredentialTransactions>,
) -> Result<credentials::CredentialSyncResult, String> {
    let pending = state
        .pending
        .lock()
        .map_err(|_| "凭据事务状态不可用".to_string())?;
    if !pending.is_empty() {
        return Err("另一个凭据保存事务正在进行".into());
    }
    let result = credentials::sync_model_credentials(models);
    security_audit::record_credential_result("model.sync", &result);
    result
}

#[tauri::command]
fn stage_model_credentials(
    models: Vec<credentials::ModelCredentialInput>,
    state: tauri::State<'_, CredentialTransactions>,
) -> Result<CredentialStageResult, String> {
    stage_credentials(
        &state,
        || credentials::sync_model_credentials(models),
        "model.sync",
    )
}

#[tauri::command]
fn sync_mcp_credentials(
    servers: Vec<credentials::McpCredentialInput>,
    state: tauri::State<'_, CredentialTransactions>,
) -> Result<credentials::CredentialSyncResult, String> {
    let pending = state
        .pending
        .lock()
        .map_err(|_| "凭据事务状态不可用".to_string())?;
    if !pending.is_empty() {
        return Err("另一个凭据保存事务正在进行".into());
    }
    let result = credentials::sync_mcp_credentials(servers);
    security_audit::record_credential_result("mcp.sync", &result);
    result
}

#[tauri::command]
fn stage_mcp_credentials(
    servers: Vec<credentials::McpCredentialInput>,
    state: tauri::State<'_, CredentialTransactions>,
) -> Result<CredentialStageResult, String> {
    stage_credentials(
        &state,
        || credentials::sync_mcp_credentials(servers),
        "mcp.sync",
    )
}

#[tauri::command]
fn sync_workflow_webhook_credential(
    secret: String,
    clear: bool,
    state: tauri::State<'_, CredentialTransactions>,
) -> Result<credentials::CredentialSyncResult, String> {
    let pending = state
        .pending
        .lock()
        .map_err(|_| "凭据事务状态不可用".to_string())?;
    if !pending.is_empty() {
        return Err("另一个凭据保存事务正在进行".into());
    }
    let result = credentials::sync_workflow_webhook_credential(secret, clear);
    security_audit::record_credential_result("webhook.sync", &result);
    result
}

#[tauri::command]
fn stage_workflow_webhook_credential(
    secret: String,
    clear: bool,
    state: tauri::State<'_, CredentialTransactions>,
) -> Result<CredentialStageResult, String> {
    stage_credentials(
        &state,
        || credentials::sync_workflow_webhook_credential(secret, clear),
        "webhook.sync",
    )
}

fn stage_credentials(
    state: &tauri::State<'_, CredentialTransactions>,
    operation: impl FnOnce() -> Result<credentials::CredentialSyncResult, String>,
    event: &str,
) -> Result<CredentialStageResult, String> {
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "凭据事务状态不可用".to_string())?;
    if !pending.is_empty() {
        return Err("另一个凭据保存事务正在进行".into());
    }
    let snapshot = credentials::capture_credential_snapshot()?;
    let result = operation();
    security_audit::record_credential_result(event, &result);
    let result = result?;
    let transaction_id = uuid::Uuid::new_v4().to_string();
    pending.insert(transaction_id.clone(), snapshot);
    Ok(CredentialStageResult {
        transaction_id,
        backend: result.backend,
        configured: result.configured,
    })
}

#[tauri::command]
fn finish_credential_transaction(
    transaction_id: String,
    commit: bool,
    state: tauri::State<'_, CredentialTransactions>,
) -> Result<(), String> {
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "凭据事务状态不可用".to_string())?;
    if commit {
        pending
            .remove(&transaction_id)
            .ok_or_else(|| "凭据事务不存在或已经结束".to_string())?;
        Ok(())
    } else {
        let snapshot = pending
            .get(&transaction_id)
            .ok_or_else(|| "凭据事务不存在或已经结束".to_string())?;
        credentials::restore_credential_snapshot(snapshot)?;
        pending.remove(&transaction_id);
        Ok(())
    }
}

#[tauri::command]
fn get_credential_health(rotation_days: Option<u64>) -> credentials::CredentialHealth {
    credentials::credential_health(rotation_days)
}

#[tauri::command]
fn get_security_audit(limit: Option<usize>) -> Vec<security_audit::SecurityAuditEntry> {
    security_audit::list(limit)
}

fn resolve_workspace_file(workspace: &str, path: &str) -> Result<PathBuf, String> {
    if workspace.trim().is_empty() || path.trim().is_empty() {
        return Err("工作区或文件路径为空".into());
    }
    let root = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|_| "当前工作区不存在".to_string())?;
    if !root.is_dir() {
        return Err("当前工作区不是目录".into());
    }
    let requested = PathBuf::from(path);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|_| "文件不存在或已经移动".to_string())?;
    if !resolved.starts_with(&root) {
        return Err("只能打开当前工作区内的文件".into());
    }
    if !resolved.is_file() {
        return Err("目标不是文件".into());
    }
    Ok(resolved)
}

#[tauri::command]
fn open_workspace_file(workspace: String, path: String) -> Result<(), String> {
    let file = resolve_workspace_file(&workspace, &path)?;
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(file)
        .spawn()
        .map_err(|error| format!("无法调用系统程序打开文件: {error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("external-navigation")
                .on_navigation(|webview, url| {
                    let internal = matches!(url.scheme(), "tauri" | "ipc")
                        || matches!(url.host_str(), Some("tauri.localhost"))
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
                            && url.port_or_known_default() == Some(5173));
                    if webview.label() != "main" || internal {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https")
                        && url.username().is_empty()
                        && url.password().is_none()
                    {
                        let _ = webview
                            .app_handle()
                            .opener()
                            .open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AgentProcess {
            pid: Mutex::new(None),
            token: uuid::Uuid::new_v4().to_string(),
            shutting_down: AtomicBool::new(false),
        })
        .manage(CredentialTransactions {
            pending: Mutex::new(HashMap::new()),
        })
        .manage(TrayState {
            close_notice_shown: AtomicBool::new(false),
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();

                let app = window.app_handle();
                let state = app.state::<TrayState>();
                if !state.close_notice_shown.swap(true, Ordering::SeqCst) {
                    let _ = app
                        .notification()
                        .builder()
                        .title("Eval 仍在运行")
                        .body("已最小化到系统托盘。右键托盘图标并选择“退出 Eval”才会彻底退出。")
                        .show();
                }
            }
        })
        .setup(|app| {
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            create_system_tray(app)?;

            let listener = std::net::TcpListener::bind(("127.0.0.1", 4096)).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    format!("本地端口 4096 不可用: {error}"),
                )
            })?;
            drop(listener);

            let (events, child) =
                spawn_agent_process(&app.handle().clone()).map_err(std::io::Error::other)?;
            *app.state::<AgentProcess>().pid.lock().unwrap() = Some(child.pid());
            append_runtime_log(
                &app.handle().clone(),
                "lifecycle",
                &format!("eval-server started pid={}", child.pid()),
            );
            emit_agent_state(
                &app.handle().clone(),
                "running",
                Some(child.pid()),
                0,
                None,
                None,
            );

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(supervise_agent_process(handle, events));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_agent_token,
            save_account_token,
            read_account_token,
            delete_account_token,
            open_account_url,
            open_external_url,
            sync_model_credentials,
            stage_model_credentials,
            sync_mcp_credentials,
            stage_mcp_credentials,
            sync_workflow_webhook_credential,
            stage_workflow_webhook_credential,
            finish_credential_transaction,
            get_credential_health,
            get_security_audit,
            open_workspace_file
        ])
        .build(tauri::generate_context!())
        .expect("启动嵌入式 AI Agent 时出错");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            handle
                .state::<AgentProcess>()
                .shutting_down
                .store(true, Ordering::SeqCst);
        }
        if matches!(event, tauri::RunEvent::Exit) {
            if let Ok(mut transactions) = handle.state::<CredentialTransactions>().pending.lock() {
                for (_, snapshot) in std::mem::take(&mut *transactions) {
                    if let Err(error) = credentials::restore_credential_snapshot(&snapshot) {
                        eprintln!("[credentials] 退出时回滚未提交事务失败: {error}");
                    }
                }
            }
            if let Some(pid) = handle.state::<AgentProcess>().pid.lock().unwrap().take() {
                terminate_process(pid);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{resolve_workspace_file, restart_attempt, restart_delay, RUNTIME_LEASE_GRACE_MS};
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn workspace_file_resolution_allows_files_and_blocks_escape() {
        let root = std::env::temp_dir().join(format!("eval-open-file-{}", std::process::id()));
        let docs = root.join("docs");
        let outside = root.with_extension("outside.md");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("guide.md"), "guide").unwrap();
        fs::write(&outside, "outside").unwrap();

        let resolved =
            resolve_workspace_file(root.to_string_lossy().as_ref(), "docs/guide.md").unwrap();
        assert_eq!(resolved, docs.join("guide.md").canonicalize().unwrap());
        let escape = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        assert!(resolve_workspace_file(root.to_string_lossy().as_ref(), &escape).is_err());
        assert!(resolve_workspace_file(root.to_string_lossy().as_ref(), "docs",).is_err());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(PathBuf::from(outside));
    }

    #[test]
    fn first_restart_waits_for_the_previous_runtime_lease() {
        expect_delay(1, RUNTIME_LEASE_GRACE_MS);
    }

    #[test]
    fn rapid_failures_back_off_and_a_stable_run_resets_the_attempt() {
        expect_delay(2, 20_000);
        expect_delay(3, 30_000);
        expect_delay(4, 60_000);
        assert_eq!(restart_attempt(4, Duration::from_secs(61)), 1);
        assert_eq!(restart_attempt(1, Duration::from_secs(1)), 2);
    }

    fn expect_delay(attempt: u32, expected_ms: u64) {
        assert_eq!(restart_delay(attempt), Duration::from_millis(expected_ms));
    }
}
