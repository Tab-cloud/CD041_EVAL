import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  deliveryFileCategory,
  deliveredFilesForRequest,
  finalizeDeliveredFiles,
  projectDeliveredFiles,
} from "../src/runtime/delivered-files.ts"
import { SessionArtifactRepo, type SessionArtifact, type SessionArtifactSnapshot } from "../src/store/session-artifact.ts"
import { SessionRepo } from "../src/store/repository.ts"
import { TaskRunRepo, type TaskRunView } from "../src/store/task-run.ts"
import { ToolRegistry } from "../src/tool/registry.ts"
import { writeTool } from "../src/tool/fs/index.ts"
import { projectToolResultArtifact } from "../src/runtime/session-artifact-projection.ts"

describe("delivered file projection", () => {
  test("projects only current root-run files inside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-delivery-"))
    const outside = mkdtempSync(join(tmpdir(), "eval-delivery-outside-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      mkdirSync(join(root, "docs"), { recursive: true })
      const source = join(root, "src", "main.ts")
      const report = join(root, "docs", "report.md")
      const ignored = join(root, "ignored.ts")
      const outsideFile = join(outside, "secret.md")
      writeFileSync(source, "export const answer = 42\n")
      writeFileSync(report, "# Report\n")
      writeFileSync(ignored, "export {}\n")
      writeFileSync(outsideFile, "# Outside\n")

      const snapshot: SessionArtifactSnapshot = {
        sessionId: "session-1",
        revision: 5,
        artifacts: [
          artifact("old-source", source, "root-1", 1, "obsolete"),
          artifact("source", source, "root-1", 2),
          artifact("report", report, "root-1", 3),
          artifact("other-run", ignored, "root-2", 4),
          artifact("outside", outsideFile, "root-1", 5),
        ],
      }

      const files = projectDeliveredFiles(snapshot, "root-1", root)
      expect(files.map((file) => file.relativePath)).toEqual(["docs/report.md", "src/main.ts"])
      expect(files.find((file) => file.name === "main.ts")).toMatchObject({
        artifactId: "source",
        category: "source",
        exists: true,
        stale: false,
      })
      expect(files.find((file) => file.name === "report.md")?.size).toBe(readFileSync(report).byteLength)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("keeps missing files visible and marks changed files stale", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-delivery-state-"))
    try {
      const changed = join(root, "changed.pdf")
      const missing = join(root, "missing.docx")
      writeFileSync(changed, "first")
      const snapshot: SessionArtifactSnapshot = {
        sessionId: "session-2",
        revision: 2,
        artifacts: [
          artifact("changed", changed, "root-1", 1),
          artifact("missing", missing, "root-1", 2, hash("missing")),
        ],
      }
      writeFileSync(changed, "second")

      const files = projectDeliveredFiles(snapshot, "root-1", root)
      expect(files.find((file) => file.name === "changed.pdf")).toMatchObject({
        category: "pdf",
        exists: true,
        stale: true,
      })
      expect(files.find((file) => file.name === "missing.docx")).toMatchObject({
        category: "document",
        exists: false,
        stale: false,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("binds real write-tool output to its root task and final delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-delivery-tool-"))
    const sessionId = `delivery-tool-session-${Date.now()}-${Math.random()}`
    const requestId = `delivery-tool-request-${Date.now()}-${Math.random()}`
    const runId = `delivery-tool-run-${Date.now()}-${Math.random()}`
    try {
      SessionRepo.create({
        id: sessionId,
        title: "delivery tool",
        agent_id: "main-agent",
        project_path: root,
      })
      const task: TaskRunView = {
        id: runId,
        requestId,
        sessionId,
        agentId: "main-agent",
        priority: 8,
        status: "running",
        message: "create source",
        workingDir: root,
        type: "chat",
        createdAt: Date.now(),
        startedAt: Date.now(),
      }
      TaskRunRepo.create(task)
      const registry = new ToolRegistry()
      registry.register(writeTool)
      const result = await registry.execute("write", {
        path: "src/main.ts",
        content: "export const delivered = true\n",
      }, {
        runId,
        runType: "root",
        sessionId,
        agentId: "main-agent",
        workingDir: root,
        scope: "auto-edit",
      })
      expect(result.success).toBe(true)
      expect(SessionArtifactRepo.snapshot(sessionId).artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "delivery-file",
          source: join(root, "src", "main.ts"),
          metadata: expect.objectContaining({ rootRunId: runId, requestId }),
        }),
      ]))

      task.status = "completed"
      task.completedAt = Date.now()
      TaskRunRepo.update(task)
      expect(finalizeDeliveredFiles(TaskRunRepo.get(runId))).toEqual([
        expect.objectContaining({
          name: "main.ts",
          category: "source",
          relativePath: "src/main.ts",
        }),
      ])
      expect(deliveredFilesForRequest(sessionId, requestId)).toHaveLength(1)
    } finally {
      SessionRepo.delete(sessionId)
      rmSync(root, { recursive: true, force: true })
    }
  })


  test("projects every certified compiler artifact into the final delivery", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-delivery-compile-"))
    const sessionId = `delivery-compile-session-${Date.now()}-${Math.random()}`
    const requestId = `delivery-compile-request-${Date.now()}-${Math.random()}`
    const runId = `delivery-compile-run-${Date.now()}-${Math.random()}`
    try {
      SessionRepo.create({
        id: sessionId,
        title: "delivery compile",
        agent_id: "main-agent",
        project_path: root,
      })
      const task: TaskRunView = {
        id: runId,
        requestId,
        sessionId,
        agentId: "main-agent",
        priority: 8,
        status: "running",
        message: "compile firmware",
        workingDir: root,
        type: "chat",
        createdAt: Date.now(),
        startedAt: Date.now(),
      }
      TaskRunRepo.create(task)
      mkdirSync(join(root, "build"), { recursive: true })
      const elf = join(root, "build", "app.elf")
      const hex = join(root, "build", "app.hex")
      writeFileSync(elf, "elf")
      writeFileSync(hex, "hex")
      projectToolResultArtifact("compile", {}, {
        success: true,
        data: {
          artifacts: [
            { path: elf, format: "elf", valid: true },
            { path: hex, format: "hex", valid: true },
            { path: join(root, "build", "invalid.bin"), format: "bin", valid: false },
          ],
        },
      }, {
        runId,
        sessionId,
        workingDir: root,
      })

      expect(SessionArtifactRepo.snapshot(sessionId).artifacts
        .filter((item) => item.kind === "delivery-file")).toHaveLength(2)
      task.status = "completed"
      task.completedAt = Date.now()
      TaskRunRepo.update(task)
      expect(finalizeDeliveredFiles(TaskRunRepo.get(runId))
        .map((file) => file.relativePath)).toEqual(["build/app.elf", "build/app.hex"])
    } finally {
      SessionRepo.delete(sessionId)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("classifies source, office and firmware deliverables without keyword routing", () => {
    expect(deliveryFileCategory("Makefile")).toBe("source")
    expect(deliveryFileCategory("firmware/main.c")).toBe("source")
    expect(deliveryFileCategory("report.pdf")).toBe("pdf")
    expect(deliveryFileCategory("slides.pptx")).toBe("presentation")
    expect(deliveryFileCategory("table.xlsx")).toBe("spreadsheet")
    expect(deliveryFileCategory("build/app.hex")).toBe("firmware")
    expect(deliveryFileCategory("cache.tmp")).toBeUndefined()
  })
  test("persists a completion manifest for history restore after the live event", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-delivery-manifest-"))
    const sessionId = `delivery-session-${Date.now()}-${Math.random()}`
    const requestId = `request-${Date.now()}-${Math.random()}`
    const runId = `run-${Date.now()}-${Math.random()}`
    try {
      SessionRepo.create({
        id: sessionId,
        title: "delivery",
        agent_id: "main-agent",
        project_path: root,
      })
      const report = join(root, "report.pdf")
      writeFileSync(report, "verified report")
      SessionArtifactRepo.upsert({
        sessionId,
        kind: "delivery-file",
        source: report,
        slot: `run:${runId}`,
        title: "report.pdf",
        content: "",
        metadata: {
          rootRunId: runId,
          requestId,
          workspaceRoot: root,
          size: readFileSync(report).byteLength,
        },
        sourceHash: fileHash(report),
      })
      const task: TaskRunView = {
        id: runId,
        requestId,
        sessionId,
        agentId: "main-agent",
        priority: 8,
        status: "completed",
        message: "create report",
        workingDir: root,
        type: "chat",
        createdAt: Date.now(),
        completedAt: Date.now(),
      }

      expect(finalizeDeliveredFiles(task)).toHaveLength(1)
      expect(deliveredFilesForRequest(sessionId, requestId)[0]).toMatchObject({
        name: "report.pdf",
        category: "pdf",
        relativePath: "report.pdf",
      })
    } finally {
      SessionRepo.delete(sessionId)
      rmSync(root, { recursive: true, force: true })
    }
  })

})

function artifact(
  id: string,
  source: string,
  rootRunId: string,
  updatedAt: number,
  sourceHash = fileHash(source),
): SessionArtifact {
  return {
    id,
    sessionId: "session",
    kind: "delivery-file",
    source,
    slot: `run:${rootRunId}`,
    title: source.split(/[/\\]/).pop() ?? source,
    content: "",
    metadata: { rootRunId },
    sourceHash,
    revision: updatedAt,
    updatedAt,
  }
}

function fileHash(path: string): string {
  return hash(readFileSync(path))
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}
