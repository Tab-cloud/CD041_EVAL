import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { translate } from "../src/i18n"

const appRoot = resolve(import.meta.dir, "..")

describe("top bar update action", () => {
  test("keeps branding in the native title bar without duplicating it in the app header", () => {
    const topBar = readFileSync(resolve(appRoot, "src/components/TopBar.tsx"), "utf8")
    expect(topBar).not.toContain('className="topbar-brand"')
    expect(topBar).not.toContain('/eval-logo.svg')
    expect(topBar).not.toContain('className="topbar-divider"')
    expect(topBar).toContain('className="topbar-title-area"')
  })

  test("shows the update action only after an update is detected", () => {
    const topBar = readFileSync(resolve(appRoot, "src/components/TopBar.tsx"), "utf8")
    const styles = readFileSync(resolve(appRoot, "src/styles.css"), "utf8")
    expect(topBar).toContain("{updateAvailable && (")
    expect(topBar).toContain('className="topbar-update-btn"')
    expect(topBar).toContain("onClick={onOpenUpdate}")
    expect(topBar).toContain("<DownloadIcon size={13}")
    expect(styles).toMatch(/\.topbar-update-btn\s*\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/)
  })

  test("wires the detected update state into the top bar instead of the sidebar", () => {
    const app = readFileSync(resolve(appRoot, "src/App.tsx"), "utf8")
    const sidebar = readFileSync(resolve(appRoot, "src/components/LeftSidebar.tsx"), "utf8")
    expect(app).toContain("updateAvailable={state.updateAvailable}")
    expect(app).toContain("onOpenUpdate={updater.open}")
    expect(sidebar).not.toContain("sidebar-update-btn")
  })

  test("exposes the same updater from the system settings page", () => {
    const app = readFileSync(resolve(appRoot, "src/App.tsx"), "utf8")
    const dialogs = readFileSync(resolve(appRoot, "src/components/AppDialogs.tsx"), "utf8")
    const settings = readFileSync(resolve(appRoot, "src/components/SystemSettingsModal.tsx"), "utf8")
    expect(app).toContain("updaterState={updater.state}")
    expect(app).toContain("onCheckForUpdate={() => void updater.checkForUpdate(true)}")
    expect(dialogs).toContain("updaterState={updaterState}")
    expect(settings).toContain('t("settings.system.updateCheck")')
    expect(settings).toContain("updateDetected ? onOpenUpdate : onCheckForUpdate")
    expect(translate("zh-CN", "settings.system.updateCheck")).toBe("检查更新")
    expect(translate("en-US", "settings.system.updateCheck")).toBe("Check for updates")
  })

  test("keeps regular background updates non-modal while mandatory updates may interrupt", () => {
    const updater = readFileSync(resolve(appRoot, "src/hooks/useAppUpdater.ts"), "utf8")
    expect(updater).toContain("open: manual || mandatory || previous.open")
    expect(translate("zh-CN", "topbar.updateAvailable")).toBe("有新版本可用")
    expect(translate("en-US", "topbar.updateAvailable")).toBe("A new version is available")
  })

  test("always registers the native updater and reads its trust root from Tauri config", () => {
    const shell = readFileSync(resolve(appRoot, "src-tauri/src/lib.rs"), "utf8")
    const config = JSON.parse(readFileSync(resolve(appRoot, "src-tauri/tauri.conf.json"), "utf8"))
    expect(shell).toContain(".plugin(tauri_plugin_updater::Builder::new().build())?")
    expect(shell).not.toContain('option_env!("EVAL_UPDATER_PUBLIC_KEY")')
    expect(config.plugins.updater.pubkey).toBeTruthy()
    expect(config.plugins.updater.endpoints).toContain(
      "https://eval.zailink.space/api/v1/updates/{{target}}/{{arch}}/{{current_version}}?channel=stable",
    )
  })
})
