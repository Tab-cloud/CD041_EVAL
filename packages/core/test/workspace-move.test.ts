import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mainAgent } from "../src/agent/definitions/main-agent.ts"
import { filterToolsForScope, evaluateToolAuthorization } from "../src/runtime/tool-policy.ts"
import { moveTool } from "../src/tool/fs/index.ts"
import { bashTool } from "../src/tool/general/bash.ts"

const policy = {
  toolPolicies: {
    fileWrite: "allow" as const,
    terminal: "ask" as const,
    network: "allow" as const,
    hardware: "ask" as const,
  },
  writePathAllowlist: [],
  commandAllowlist: [],
}

describe("workspace move tool", () => {
  test("renames a workspace file without requiring generic shell authority", async () => {
    await withWorkspace(async (workspace) => {
      writeFileSync(join(workspace, "draft.ppt"), "content", "utf8")

      const result = await moveTool.execute({
        source: "draft.ppt",
        destination: "docs/report.pptx",
      }, {
        sessionId: "move-session",
        agentId: mainAgent.id,
        workingDir: workspace,
      })

      expect(result.success).toBe(true)
      expect(existsSync(join(workspace, "draft.ppt"))).toBe(false)
      expect(readFileSync(join(workspace, "docs", "report.pptx"), "utf8")).toBe("content")
    })
  })

  test("refuses workspace escape and does not overwrite an existing target", async () => {
    await withWorkspace(async (workspace) => {
      writeFileSync(join(workspace, "source.txt"), "source", "utf8")
      writeFileSync(join(workspace, "target.txt"), "target", "utf8")

      const overwrite = await moveTool.execute({
        source: "source.txt",
        destination: "target.txt",
      }, {
        sessionId: "move-session",
        agentId: mainAgent.id,
        workingDir: workspace,
      })
      const escape = await moveTool.execute({
        source: "source.txt",
        destination: "../escaped.txt",
      }, {
        sessionId: "move-session",
        agentId: mainAgent.id,
        workingDir: workspace,
      })

      expect(overwrite.success).toBe(false)
      expect(overwrite.error).toContain("未覆盖")
      expect(escape.success).toBe(false)
      expect(escape.error).toContain("路径越权")
      expect(readFileSync(join(workspace, "source.txt"), "utf8")).toBe("source")
      expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("target")
    })
  })

  test("is automatic in auto-edit while generic bash remains approval-gated", () => {
    const visible = filterToolsForScope(mainAgent, [moveTool, bashTool], "auto-edit", policy)

    expect(visible.map((tool) => tool.name)).toEqual(["move", "bash"])
    expect(evaluateToolAuthorization(
      mainAgent,
      moveTool,
      new Set(["move"]),
      "auto-edit",
      { source: "draft.ppt", destination: "draft.pptx" },
      policy,
    ).action).toBe("allow")
    expect(evaluateToolAuthorization(
      mainAgent,
      bashTool,
      new Set(["move", "bash"]),
      "auto-edit",
      { command: "where git" },
      policy,
    ).action).toBe("ask")
  })
})

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "eval-workspace-move-"))
  try {
    await run(workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}
