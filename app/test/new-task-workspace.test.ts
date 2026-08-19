import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { translate } from "../src/i18n"

const appRoot = resolve(import.meta.dir, "..")

describe("new task workspace selection", () => {
  test("keeps the selected path editable when the native picker cannot return it", () => {
    const dialog = readFileSync(resolve(appRoot, "src/components/NewTaskDialog.tsx"), "utf8")
    expect(dialog).toContain('className="input-field form-workspace-path"')
    expect(dialog).toContain("onChange={(event) => setWorkspace(event.target.value)}")
    expect(dialog).toContain('t("newTask.workspacePlaceholder")')
    expect(dialog).toContain('t("newTask.browse")')
  })

  test("provides localized path fallback labels", () => {
    expect(translate("zh-CN", "newTask.workspacePlaceholder")).toBe("输入或选择工作空间文件夹")
    expect(translate("en-US", "newTask.workspacePlaceholder")).toBe("Enter or choose a workspace folder")
    expect(translate("zh-CN", "newTask.browse")).toBe("浏览")
    expect(translate("en-US", "newTask.browse")).toBe("Browse")
  })
})
