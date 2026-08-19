import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { accountInitial, desktopBindingEndpointUnavailable, normalizeAccountUser } from "../src/account"

describe("desktop account binding", () => {
  test("accepts current Eval Web account profiles", () => {
    expect(normalizeAccountUser({
      id: "usr_1",
      username: "engineer",
      email: "engineer@example.com",
      phoneE164: null,
      accountLocale: "zh",
      displayName: "Engineer",
      role: "member",
    })).toEqual({
      id: "usr_1",
      username: "engineer",
      email: "engineer@example.com",
      phoneE164: null,
      accountLocale: "zh",
      displayName: "Engineer",
      role: "member",
    })
    expect(() => normalizeAccountUser({ id: "usr_1", role: "owner" })).toThrow("账号资料格式无效")
  })

  test("accepts optional identity fields omitted by the Web desktop session", () => {
    const profile = normalizeAccountUser({
      id: "usr_2",
      accountLocale: "zh",
      displayName: "Eval User",
      role: "member",
    })
    expect(profile.username).toBeNull()
    expect(profile.email).toBeNull()
    expect(profile.phoneE164).toBeNull()
  })

  test("uses the username initial for the signed-in desktop avatar", () => {
    expect(accountInitial({ username: "engineer", displayName: "Eval User" })).toBe("E")
    expect(accountInitial({ username: " 张三", displayName: "Zhang" })).toBe("张")
    expect(accountInitial({ username: null, displayName: "  alice" })).toBe("A")
    expect(accountInitial({ username: "---", displayName: "" })).toBe("?")
  })

  test("stores the desktop token in Windows Credential Manager and allowlists the browser origin", async () => {
    const root = resolve(import.meta.dir, "..")
    const [credentials, shell, cargo, capability, account, accountUi] = await Promise.all([
      Bun.file(resolve(root, "src-tauri/src/credentials.rs")).text(),
      Bun.file(resolve(root, "src-tauri/src/lib.rs")).text(),
      Bun.file(resolve(root, "src-tauri/Cargo.toml")).text(),
      Bun.file(resolve(root, "src-tauri/capabilities/default.json")).text(),
      Bun.file(resolve(root, "src/account.ts")).text(),
      Bun.file(resolve(root, "src/components/SettingsAccount.tsx")).text(),
    ])
    expect(credentials).toContain("Eval/account/session")
    expect(credentials).toContain("save_account_token")
    expect(shell).toContain('parsed.host_str() == Some("eval.zailink.space")')
    const accountUrlCommand = shell.split("fn open_account_url", 2)[1]?.split("#[tauri::command]", 1)[0] ?? ""
    expect(accountUrlCommand).toContain("app.opener()")
    expect(accountUrlCommand).toContain(".open_url(parsed.as_str(), None::<&str>)")
    expect(accountUrlCommand).not.toContain("explorer.exe")
    expect(shell).toContain("tauri_plugin_opener::init()")
    expect(cargo).toContain('tauri-plugin-opener = "2"')
    expect(capability).toContain("https://eval.zailink.space/*")
    expect(accountUi).toContain("Windows Credential Manager")
    expect(account).not.toMatch(/localStorage.*token|sessionStorage.*token/)
  })

  test("falls back to the working Web login when an older server has no desktop binding routes", async () => {
    expect(desktopBindingEndpointUnavailable(404)).toBe(true)
    expect(desktopBindingEndpointUnavailable(405)).toBe(true)
    expect(desktopBindingEndpointUnavailable(501)).toBe(true)
    expect(desktopBindingEndpointUnavailable(401)).toBe(false)

    const root = resolve(import.meta.dir, "..")
    const [app, account, accountUi, topbar] = await Promise.all([
      Bun.file(resolve(root, "src/App.tsx")).text(),
      Bun.file(resolve(root, "src/account.ts")).text(),
      Bun.file(resolve(root, "src/components/SettingsAccount.tsx")).text(),
      Bun.file(resolve(root, "src/components/TopBar.tsx")).text(),
    ])
    expect(account).toContain("/login?returnTo=")
    expect(account).toContain("await openAccountLogin()")
    expect(accountUi).toContain("beginAccountLogin()")
    expect(app).toContain("accountLoginAutoStartRef.current = true")
    expect(app).toContain('settingsTabRef.current = "account"')
    expect(accountUi).toContain("autoStartPending")
    expect(accountUi).toContain("pollAccountBinding(binding.deviceCode)")
    expect(topbar).toContain('className="topbar-icon-btn"')
    expect(topbar).toContain('<UserIcon size={16} />')
    expect(topbar).toContain('className="topbar-account-initial"')
    expect(topbar).not.toContain('<span>{t("topbar.account")}</span>')
  })

  test("does not mount the workspace runtime until a desktop account is verified", async () => {
    const root = resolve(import.meta.dir, "..")
    const [app, gate, accountUi] = await Promise.all([
      Bun.file(resolve(root, "src/App.tsx")).text(),
      Bun.file(resolve(root, "src/components/AccountGate.tsx")).text(),
      Bun.file(resolve(root, "src/components/SettingsAccount.tsx")).text(),
    ])
    const [accessShell, authenticatedRuntime = ""] = app.split("function AuthenticatedApp", 2)
    expect(accessShell).toContain("accountChecking || !accountUser")
    expect(accessShell).toContain("<AccountGate")
    expect(accessShell).toContain("<AuthenticatedApp")
    expect(accessShell).not.toContain("useChat(")
    expect(accessShell).not.toContain("useAppLifecycle(")
    expect(authenticatedRuntime).toContain("useChat(")
    expect(authenticatedRuntime).toContain("useAppLifecycle(")
    expect(gate).toContain("<SettingsAccount language={language} required")
    expect(accountUi).toContain("登录成功前，会话、任务、指令队列与 Agent 工具保持锁定")
  })
})
