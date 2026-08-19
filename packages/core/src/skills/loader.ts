/**
 * Skills Loader — 加载 SKILL.md 文件并注入到系统提示词
 *
 * 发现路径: 项目 .eval/skills/ → 全局 ~/.eval/skills/ → 内置 skills/
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { BUILTIN_SKILL_DOCUMENTS } from "./builtins.generated"

export interface Skill {
  name: string
  description: string
  content: string
  version: string
  triggers: string[]
  source: "project" | "user" | "builtin"
  path: string
  baseDir: string
}

/** 从 Markdown YAML frontmatter 解析 name/description */
export function parseSkill(raw: string, source: Skill["source"] = "user", path = ""): Skill | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return null

  const frontmatter = match[1]
  const content = match[2].trim()

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
  const versionMatch = frontmatter.match(/^version:\s*(.+)$/m)
  const triggersMatch = frontmatter.match(/^triggers:\s*(.+)$/m)

  const name = yamlScalar(nameMatch?.[1])
  const description = yamlScalar(descMatch?.[1])
  if (!isPortableSkillName(name) || !description) return null

  return {
    name,
    description,
    content: content,
    version: versionMatch?.[1].trim() ?? "1.0.0",
    triggers: triggersMatch?.[1].split(",").map((item) => item.trim()).filter(Boolean) ?? [],
    source,
    path,
    baseDir: path ? dirname(path) : "",
  }
}

function readSkillsFromDir(dir: string, source: Skill["source"]): Skill[] {
  if (!existsSync(dir)) return []
  const skills: Skill[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const path = join(dir, entry.name)
        const raw = readFileSync(path, "utf-8")
        const skill = parseSkill(raw, source, path)
        if (skill) skills.push(skill)
      } else if (entry.isDirectory()) {
        const path = join(dir, entry.name, "SKILL.md")
        if (!existsSync(path)) continue
        const skill = parseSkill(readFileSync(path, "utf-8"), source, path)
        if (skill) skills.push(skill)
      }
    }
  } catch { /* ignore */ }
  return skills
}

/** 发现所有可用的 Skills */
export function discoverSkills(projectRoot?: string): Skill[] {
  const seen = new Set<string>()
  const skills: Skill[] = []

  // 优先级: 项目 > 全局 > 内置
  const dirs: Array<{ path: string; source: Skill["source"] }> = []

  // Project-local Eval skills take precedence, followed by the compatible
  // .agents/skills layout used by mature coding agents. When the supplied
  // workspace is nested inside a repository, scan only up to that repository
  // root; never walk arbitrary ancestors outside a repository boundary.
  if (projectRoot) {
    for (const root of projectSearchRoots(projectRoot)) {
      dirs.push({ path: join(root, ".eval", "skills"), source: "project" })
      dirs.push({ path: join(root, ".agents", "skills"), source: "project" })
    }
  }

  // 全局
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~"
  dirs.push({ path: join(home, ".eval", "skills"), source: "user" })
  dirs.push({ path: join(home, ".agents", "skills"), source: "user" })

  for (const dir of dirs) {
    for (const skill of readSkillsFromDir(dir.path, dir.source)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name)
        skills.push(skill)
      }
    }
  }

  for (const raw of BUILTIN_SKILL_DOCUMENTS) {
    const skill = parseSkill(raw, "builtin")
    if (skill && !seen.has(skill.name)) {
      seen.add(skill.name)
      skills.push({ ...skill, path: `builtin:${skill.name}`, baseDir: "" })
    }
  }

  return skills
}

/** 格式化 Skills 列表为 LLM 可用的文本 */
export function formatSkills(skills: Skill[]): string {
  if (skills.length === 0) return ""
  const lines = [
    "## Available Skills",
    "",
    "You can invoke a skill by its name using the `skill` tool.",
    "",
  ]
  for (const s of skills) {
    lines.push(`- **${s.name}**: ${s.description}`)
  }
  return lines.join("\n")
}

/** 加载指定 Skill 的完整内容 */
export function loadSkill(name: string, skills: Skill[]): Skill | null {
  return skills.find((s) => s.name === name) ?? null
}

export function isPortableSkillName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
}

function yamlScalar(value: string | undefined): string {
  const trimmed = value?.trim() ?? ""
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function projectSearchRoots(projectRoot: string): string[] {
  const start = resolve(projectRoot)
  let repositoryRoot = ""
  let current = start
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, ".git"))) { repositoryRoot = current; break }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (!repositoryRoot) return [start]
  const roots: string[] = []
  current = start
  while (true) {
    roots.push(current)
    if (current === repositoryRoot) break
    current = dirname(current)
  }
  return roots
}
