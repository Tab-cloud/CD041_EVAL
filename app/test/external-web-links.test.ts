import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveExternalWebUrl } from "../src/external-links"

const appRoot = resolve(import.meta.dir, "..")

describe("external web links", () => {
  test("resolves Eval blog and forum links to the public Web origin", () => {
    expect(resolveExternalWebUrl("/blog/r818-guide")).toBe("https://eval.zailink.space/blog/r818-guide")
    expect(resolveExternalWebUrl("forum/r818-help")).toBe("https://eval.zailink.space/forum/r818-help")
    expect(resolveExternalWebUrl("https://eval.zailink.space/blog/r818-guide")).toBe("https://eval.zailink.space/blog/r818-guide")
  })

  test("allows ordinary Web links but rejects embedded credentials and non-Web schemes", () => {
    expect(resolveExternalWebUrl("https://example.com/docs?q=1")).toBe("https://example.com/docs?q=1")
    expect(resolveExternalWebUrl("https://user:secret@example.com/private")).toBeNull()
    expect(resolveExternalWebUrl("file:///C:/Windows/System32")).toBeNull()
    expect(resolveExternalWebUrl("javascript:alert(1)")).toBeNull()
  })

  test("prevents the main WebView from navigating and delegates to the native browser command", () => {
    const markdown = readFileSync(resolve(appRoot, "src/components/ChatMarkdown.tsx"), "utf8")
    const shell = readFileSync(resolve(appRoot, "src-tauri/src/lib.rs"), "utf8")
    expect(markdown).toContain("event.preventDefault()")
    expect(markdown).toContain("openExternalWebUrl(href)")
    expect(markdown).toContain('target="_blank"')
    expect(shell).toContain("fn open_external_url")
    expect(shell).toContain('matches!(parsed.scheme(), "http" | "https")')
    expect(shell).toContain("open_external_url,")
    expect(shell).toContain('Builder::<tauri::Wry, ()>::new("external-navigation")')
    expect(shell).toContain(".on_navigation(|webview, url|")
    expect(shell).toContain('webview.label() != "main" || internal')
  })
})
