import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { assertSafeUrl } from "../tool/general/webfetch"
import { discoverSkills, isPortableSkillName, parseSkill, type Skill } from "./loader"

export interface SkillInstallInput {
  location?: string
  content?: string
  target: "user" | "project"
  projectPath?: string
}

export function listManagedSkills(projectPath?: string, disabledIds: string[] = []) {
  const disabled = new Set(disabledIds)
  return discoverSkills(projectPath).map((skill) => ({
    name: skill.name,
    description: skill.description,
    version: skill.version,
    triggers: skill.triggers,
    source: skill.source,
    path: skill.path,
    enabled: !disabled.has(skill.name),
    editable: skill.source !== "builtin",
    preview: skill.content.slice(0, 1_200),
  }))
}

export async function installSkill(input: SkillInstallInput): Promise<Skill> {
  let raw = input.content?.trim() ?? ""
  let temporaryDir = ""
  let bundleSourceDir = ""
  try {
    if (!raw && input.location) {
      if (/^https?:\/\//i.test(input.location)) {
        if (isGitLocation(input.location)) {
          await assertSafeUrl(input.location)
          temporaryDir = mkdtempSync(join(tmpdir(), "eval-skill-"))
          const process = Bun.spawn(["git", "clone", "--depth", "1", input.location, temporaryDir], { stdout: "ignore", stderr: "pipe" })
          if (await process.exited !== 0) throw new Error(`Git 安装失败: ${await new Response(process.stderr).text()}`)
          const skillPath = findSkillFile(temporaryDir)
          if (!skillPath) throw new Error("仓库中未找到 SKILL.md 或 Skill Markdown")
          raw = readFileSync(skillPath, "utf8")
          bundleSourceDir = dirname(skillPath)
        } else {
          raw = await downloadPublicSkill(input.location)
        }
      } else {
        const sourcePath = resolve(input.location)
        if (!existsSync(sourcePath)) throw new Error("本地 Skill 路径不存在")
        const sourceInfo = lstatSync(sourcePath)
        if (sourceInfo.isSymbolicLink()) throw new Error("Skill 来源不允许是符号链接")
        const skillPath = sourceInfo.isDirectory() ? findSkillFile(sourcePath) : sourcePath
        if (!skillPath || extname(skillPath).toLowerCase() !== ".md") throw new Error("本地 Skill 必须是 SKILL.md、Skill 目录或 Markdown 文件")
        raw = readFileSync(skillPath, "utf8")
        if (sourceInfo.isDirectory() || basename(skillPath).toLowerCase() === "skill.md") bundleSourceDir = dirname(skillPath)
      }
    }
    if (!raw || raw.length > 500_000) throw new Error("Skill 内容为空或超过 500KB")
    const source = input.target === "project" ? "project" : "user"
    const parsed = parseSkill(raw, source)
    if (!parsed || !isPortableSkillName(parsed.name)) throw new Error("Skill 必须包含有效的 YAML frontmatter name 和 description；name 仅支持小写字母、数字和连字符")
    const targetDir = skillDirectory(input.target, input.projectPath)
    mkdirSync(targetDir, { recursive: true })
    const bundleDir = join(targetDir, parsed.name)
    const legacyPath = join(targetDir, `${parsed.name}.md`)
    rmSync(bundleDir, { recursive: true, force: true })
    if (existsSync(legacyPath)) unlinkSync(legacyPath)
    if (bundleSourceDir) copySkillBundle(bundleSourceDir, bundleDir)
    else mkdirSync(bundleDir, { recursive: true })
    const path = join(bundleDir, "SKILL.md")
    writeFileSync(path, `${raw.trim()}\n`, { encoding: "utf8", mode: 0o600 })
    return { ...parsed, path, baseDir: bundleDir }
  } finally {
    if (temporaryDir) rmSync(temporaryDir, { recursive: true, force: true })
  }
}

export function deleteSkill(path: string, projectPath?: string): void {
  const absolute = resolve(path)
  const allowed = [
    skillDirectory("user"), join(homedir(), ".agents", "skills"),
    ...(projectPath ? [skillDirectory("project", projectPath), join(resolve(projectPath), ".agents", "skills")] : []),
  ]
  if (!allowed.some((dir) => {
    const relation = relative(resolve(dir), absolute)
    return Boolean(relation) && !relation.startsWith("..") && !isAbsolute(relation)
  })) throw new Error("只能删除用户或当前项目 Skill")
  if (!existsSync(absolute) || extname(absolute).toLowerCase() !== ".md") throw new Error("Skill 不存在")
  if (basename(absolute).toLowerCase() === "skill.md") {
    const bundleDir = dirname(absolute)
    const isChildBundle = allowed.some((dir) => {
      const relation = relative(resolve(dir), bundleDir)
      return Boolean(relation) && !relation.startsWith("..") && !isAbsolute(relation)
    })
    if (!isChildBundle) throw new Error("不能删除 Skill 根目录")
    rmSync(bundleDir, { recursive: true, force: true })
  } else unlinkSync(absolute)
}

function skillDirectory(target: "user" | "project", projectPath?: string): string {
  if (target === "project") {
    if (!projectPath) throw new Error("安装项目 Skill 需要工作空间")
    return join(resolve(projectPath), ".eval", "skills")
  }
  return join(homedir(), ".eval", "skills")
}

function findSkillFile(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true })
  const preferred = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md")
  if (preferred) return join(dir, preferred.name)
  for (const entry of entries) {
    if (entry.name === ".git") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findSkillFile(path)
      if (found) return found
    }
  }
  const fallback = entries.find((entry) => entry.isFile() && entry.name.endsWith(".md"))
  if (fallback) return join(dir, fallback.name)
  return null
}

function isGitLocation(value: string): boolean {
  return value.endsWith(".git") || /^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(value)
}

function copySkillBundle(sourceDir: string, targetDir: string): void {
  let files = 0
  let totalBytes = 0
  const copy = (source: string, target: string): void => {
    const info = lstatSync(source)
    if (info.isSymbolicLink()) throw new Error("Skill 包不允许包含符号链接")
    if (info.isDirectory()) {
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue
        copy(join(source, entry.name), join(target, entry.name))
      }
      return
    }
    if (!info.isFile()) throw new Error("Skill 包包含不支持的文件类型")
    files += 1
    totalBytes += info.size
    if (files > 500 || totalBytes > 20 * 1024 * 1024) throw new Error("Skill 包过大（最多 500 个文件 / 20MB）")
    copyFileSync(source, target)
  }
  copy(sourceDir, targetDir)
}

async function downloadPublicSkill(rawUrl: string): Promise<string> {
  let url = await assertSafeUrl(rawUrl)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 5) throw new Error("下载 Skill 失败：重定向次数过多")
      const location = response.headers.get("location")
      if (!location) throw new Error(`下载 Skill 失败: HTTP ${response.status}`)
      url = await assertSafeUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok) throw new Error(`下载 Skill 失败: HTTP ${response.status}`)
    const declared = Number(response.headers.get("content-length") ?? "0")
    if (Number.isFinite(declared) && declared > 500_000) throw new Error("Skill 内容超过 500KB")
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > 500_000) throw new Error("Skill 内容超过 500KB")
    return text
  }
  throw new Error("下载 Skill 失败")
}
