import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverSkills, formatSkills, parseSkill } from "../src/skills/loader"
import { deleteSkill, installSkill } from "../src/skills/manager"
import { mainAgent } from "../src/agent/definitions/main-agent"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("portable Skill discovery", () => {
  test("requires portable names and descriptions", () => {
    expect(parseSkill("---\nname: Good_Name\ndescription: bad\n---\nBody")).toBeNull()
    expect(parseSkill("---\nname: good-name\n---\nBody")).toBeNull()
    expect(parseSkill("---\nname: good-name\ndescription: Ready\n---\nBody")?.name).toBe("good-name")
  })

  test("discovers directory Skills up to the repository root with nearest precedence", () => {
    const root = temporaryRoot()
    mkdirSync(join(root, ".git"), { recursive: true })
    const workspace = join(root, "firmware", "board")
    mkdirSync(join(workspace, ".eval", "skills", "shared"), { recursive: true })
    mkdirSync(join(root, ".agents", "skills", "shared"), { recursive: true })
    mkdirSync(join(root, ".agents", "skills", "root-only"), { recursive: true })
    writeFileSync(join(workspace, ".eval", "skills", "shared", "SKILL.md"), skill("shared", "Nearest", "nearest body"))
    writeFileSync(join(root, ".agents", "skills", "shared", "SKILL.md"), skill("shared", "Parent", "parent body"))
    writeFileSync(join(root, ".agents", "skills", "root-only", "SKILL.md"), skill("root-only", "Root", "root body"))

    const skills = discoverSkills(workspace)
    expect(skills.find((item) => item.name === "shared")?.content).toBe("nearest body")
    expect(skills.find((item) => item.name === "root-only")?.source).toBe("project")
    expect(formatSkills(skills)).not.toContain("nearest body")
  })

  test("installs and deletes a complete Skill bundle", async () => {
    const root = temporaryRoot()
    const source = join(root, "source")
    const project = join(root, "project")
    mkdirSync(join(source, "scripts"), { recursive: true })
    mkdirSync(project, { recursive: true })
    writeFileSync(join(source, "SKILL.md"), skill("bundle-skill", "Bundle", "Use scripts/check.ps1"))
    writeFileSync(join(source, "scripts", "check.ps1"), "Write-Output ready")

    const installed = await installSkill({ location: source, target: "project", projectPath: project })
    expect(installed.path).toBe(join(project, ".eval", "skills", "bundle-skill", "SKILL.md"))
    expect(existsSync(join(installed.baseDir, "scripts", "check.ps1"))).toBe(true)
    expect(discoverSkills(project).find((item) => item.name === "bundle-skill")?.baseDir).toBe(installed.baseDir)

    deleteSkill(installed.path, project)
    expect(existsSync(installed.baseDir)).toBe(false)
  })

  test("provides a built-in blog workflow with the exact community tool contract", () => {
    const blog = discoverSkills().find((item) => item.name === "write-blog")
    expect(blog?.source).toBe("builtin")
    expect(blog?.description).toContain("发布")
    expect(blog?.content).toContain("community_blog_create_draft({ title, excerpt, body })")
    expect(blog?.content).toContain("博客草稿没有 `category` 参数")
    expect(blog?.content).toContain("草稿创建失败时不得调用发布工具")
    expect(mainAgent.systemPrompt).toContain('skill(name="write-blog")')
  })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "eval-skill-test-"))
  temporaryRoots.push(root)
  return root
}

function skill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
}
