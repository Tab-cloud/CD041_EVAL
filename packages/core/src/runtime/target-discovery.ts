import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, extname, join, relative } from "node:path"
import { SessionArtifactRepo } from "../store/session-artifact.ts"

export interface LocalTargetEvidence {
  source: string
  kind: "build-definition" | "linker-script" | "schematic" | "datasheet" | "document"
  candidates: string[]
  excerpt?: string
  cpu?: string
  linkerScripts?: string[]
  origin?: "workspace" | "session-artifact"
  artifactId?: string
  stale?: boolean
  verification?: string
}

export interface TargetBuildConsistency {
  verdict: "consistent" | "conflict" | "insufficient"
  evidence: LocalTargetEvidence[]
  reasons: string[]
}

export interface RankedTargetCandidate {
  model: string
  score: number
  sources: string[]
  explicitlyDeclared: boolean
  mainControllerEvidence: boolean
}

export interface ResolvedTargetFamily {
  family: string
  sources: string[]
}

const SKIP_DIRS = new Set([".git", ".eval", "node_modules", "build", "dist", "release", "target"])
const TEXT_NAMES = /^(?:makefile|cmakelists\.txt|platformio\.ini|sdkconfig)$/i
const TEXT_EXTENSIONS = new Set([".mk", ".cmake", ".txt", ".md", ".rst", ".json", ".toml", ".yaml", ".yml", ".h", ".hpp"])
const SCHEMATIC_EXTENSIONS = new Set([".pdf", ".sch", ".kicad_sch"])

/**
 * Bounded, read-only discovery. Results are evidence candidates only: this
 * function deliberately never selects or confirms a hardware target.
 */
export function discoverLocalTargetEvidence(projectDir: string): LocalTargetEvidence[] {
  const files: string[] = []
  walk(projectDir, files, 0)
  const evidence: LocalTargetEvidence[] = []

  for (const file of files) {
    const rel = relative(projectDir, file) || basename(file)
    const ext = extname(file).toLowerCase()
    const lower = basename(file).toLowerCase()
    if (SCHEMATIC_EXTENSIONS.has(ext)) {
      evidence.push({
        source: rel,
        kind: /datasheet|手册|规格书|manual/i.test(rel) ? "datasheet" : "schematic",
        candidates: candidateTokens(basename(file)).map(stripEvidenceFilePrefix),
      })
      continue
    }
    if (!TEXT_NAMES.test(lower) && !TEXT_EXTENSIONS.has(ext)) continue
    let raw = ""
    try {
      if (statSync(file).size > 2 * 1024 * 1024) continue
      raw = readFileSync(file, "utf8")
    } catch {
      continue
    }
    const isBuildDefinition = TEXT_NAMES.test(lower) || ext === ".mk" || ext === ".cmake"
    const candidates = new Set<string>()
    for (const match of raw.matchAll(/(?:^|\s)-D\s*([A-Za-z][A-Za-z0-9_-]{3,})/gm)) candidates.add(match[1]!)
    for (const match of raw.matchAll(/^\s*(?:CHIP|MCU|TARGET(?:_CHIP)?)\s*[:?+]?=\s*([A-Za-z][A-Za-z0-9_-]{3,})/gim)) {
      candidates.add(match[1]!)
    }
    const linkerScripts: string[] = []
    for (const match of raw.matchAll(/(?:^|\s)-T\s*["']?([^\s"']+\.ld)/gm)) {
      const linker = basename(match[1]!)
      linkerScripts.push(linker)
      candidates.add(basename(linker, ".ld").toUpperCase())
    }
    if (!isBuildDefinition) {
      for (const token of candidateTokens(raw)) candidates.add(token)
    }
    const cpu = raw.match(/-mcpu=([A-Za-z0-9+_-]+)/i)?.[1]
    const relevantLine = raw.split(/\r?\n/).find((line) => /(?:芯片|主控|\bMCU\b|CROSS_COMPILE|-mcpu=|\btarget\b)/i.test(line))
    if (candidates.size > 0 || relevantLine || cpu) {
      evidence.push({
        source: rel,
        kind: isBuildDefinition ? "build-definition"
          : ext === ".ld" ? "linker-script" : "document",
        candidates: [...candidates].slice(0, 20),
        excerpt: relevantLine?.trim().slice(0, 300),
        cpu,
        linkerScripts: linkerScripts.length ? linkerScripts : undefined,
      })
    }
  }
  return evidence.slice(0, 80)
}

/**
 * Reuse the session's durable schematic/document read model before asking a
 * vision model to inspect the same source again. Stale artifacts remain
 * visible as diagnostics but must not be treated as current proof.
 */
export function discoverSessionTargetEvidence(sessionId: string): LocalTargetEvidence[] {
  if (!sessionId) return []
  return SessionArtifactRepo.snapshot(sessionId).artifacts.flatMap((artifact) => {
    const candidates = candidateTokens(`${artifact.title}\n${artifact.content}`)
    const relevantLine = artifact.content.split(/\r?\n/)
      .find((line) => /(?:主控|芯片|型号|\bMCU\b|\btarget\b)/i.test(line))
    if (candidates.length === 0 && !relevantLine) return []
    const currentHash = hashFile(artifact.source)
    const verification = artifactVerification(artifact.metadata)
    const kind: LocalTargetEvidence["kind"] = artifact.kind === "datasheet" ? "datasheet"
      : artifact.kind === "schematic-page" || artifact.kind === "schematic-summary" ? "schematic"
        : "document"
    return [{
      source: artifact.source,
      kind,
      candidates,
      excerpt: relevantLine?.trim().slice(0, 500),
      origin: "session-artifact" as const,
      artifactId: artifact.id,
      stale: Boolean(artifact.sourceHash && currentHash && artifact.sourceHash !== currentHash),
      verification,
    }]
  }).slice(0, 40)
}

export function assessTargetBuildConsistency(
  projectDir: string,
  target: { model: string; family?: string; expectedCpuFlags?: string },
  evidenceOverride?: LocalTargetEvidence[],
): TargetBuildConsistency {
  const evidence = (evidenceOverride ?? discoverLocalTargetEvidence(projectDir))
    .filter((item) => item.kind === "build-definition" || item.kind === "linker-script")
  const aliases = [target.model, target.family ?? ""].map(normalizeIdentity).filter((item) => item.length >= 4)
  const buildCandidates = evidence.flatMap((item) => item.candidates)
  const candidateMatch = buildCandidates.some((candidate) => {
    const normalized = normalizeIdentity(candidate)
    return aliases.some((alias) => targetIdentityEquivalent(normalized, alias))
  })
  const expectedCpu = target.expectedCpuFlags?.match(/-mcpu=([A-Za-z0-9+_-]+)/i)?.[1]?.toLowerCase()
  const observedCpus = [...new Set(evidence.map((item) => item.cpu?.toLowerCase()).filter(Boolean) as string[])]
  const cpuConflict = Boolean(expectedCpu && observedCpus.length > 0 && !observedCpus.includes(expectedCpu))
  const cpuMatch = Boolean(expectedCpu && observedCpus.includes(expectedCpu))
  const reasons: string[] = []
  const insufficientReasons: string[] = []

  if (cpuConflict) {
    reasons.push(`项目目标要求 -mcpu=${expectedCpu}，构建定义使用 ${observedCpus.map((cpu) => `-mcpu=${cpu}`).join("、")}`)
  }
  if (buildCandidates.length > 0 && !candidateMatch) {
    const mismatch = `项目目标 ${target.model}${target.family ? ` / ${target.family}` : ""} 与构建候选 ${[...new Set(buildCandidates)].join("、")} 未建立可验证关联`
    // A different lexical build token is not proof of a conflict when the
    // confirmed product is a module/SiP and its MCU family is unknown. In that
    // case the safe verdict is insufficient evidence, which launches identity
    // enrichment rather than asking the user to overturn a confirmed target.
    if (target.family) reasons.push(mismatch)
    else insufficientReasons.push(mismatch)
  }
  if (reasons.length > 0) return { verdict: "conflict", evidence, reasons }
  if (candidateMatch || cpuMatch) return { verdict: "consistent", evidence, reasons: [] }
  return {
    verdict: "insufficient",
    evidence,
    reasons: insufficientReasons.length > 0
      ? insufficientReasons
      : ["构建定义中没有足以关联到已确认目标的芯片标识或 CPU 参数"],
  }
}

/**
 * Resolve a confirmed product model to the build family already present in
 * the project. This is intentionally an evidence join, not a lexical guess:
 * a fresh verified session artifact must name the product and a concrete MCU
 * identifier that agrees with a build-definition candidate.
 */
export function resolveVerifiedTargetFamily(
  model: string,
  buildEvidence: LocalTargetEvidence[],
  sessionEvidence: LocalTargetEvidence[],
): ResolvedTargetFamily | undefined {
  const buildFamilies = targetBuildFamilyOptions(buildEvidence)
  if (buildFamilies.length === 0) return
  const verified = sessionEvidence.filter((item) =>
    !item.stale
    && /^(?:PASS|VERIFIED|CONSISTENT)$/i.test(item.verification ?? "")
    && item.candidates.some((candidate) => targetIdentityEquivalent(candidate, model)))
  for (const family of buildFamilies) {
    const sources = verified
      .filter((item) => item.candidates.some((candidate) =>
        !targetIdentityEquivalent(candidate, model)
        && targetIdentityEquivalent(candidate, family)))
      .map((item) => item.source)
    if (sources.length > 0) return { family, sources: [...new Set(sources)] }
  }
  return
}

/** Candidate MCU families extracted from build definitions for a targeted UI. */
export function targetBuildFamilyOptions(evidence: LocalTargetEvidence[]): string[] {
  const candidates = evidence
    .filter((item) => item.kind === "build-definition" || item.kind === "linker-script")
    .flatMap((item) => item.candidates)
    .map(normalizeBuildFamilyCandidate)
    .filter((item): item is string => Boolean(item))
  const unique = [...new Map(candidates.map((item) => [normalizeIdentity(item), item])).values()]
  return unique.filter((candidate) =>
    !unique.some((other) => other !== candidate
      && normalizeIdentity(candidate).startsWith(normalizeIdentity(other))
      && normalizeIdentity(candidate).length > normalizeIdentity(other).length))
    .slice(0, 4)
}

export function targetIdentityEquivalent(left: string, right: string): boolean {
  const a = normalizeIdentity(left)
  const b = normalizeIdentity(right)
  if (!a || !b) return false
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true
  if (a.length !== b.length) return false
  return wildcardIdentityMatches(a, b) || wildcardIdentityMatches(b, a)
}

function wildcardIdentityMatches(pattern: string, value: string): boolean {
  if (!pattern.includes("X")) return false
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "X" && pattern[index] !== value[index]) return false
  }
  return true
}

function normalizeBuildFamilyCandidate(value: string): string | undefined {
  const trimmed = value.trim()
    .replace(/(?:[_-]?(?:FLASH|RAM|STARTUP|BOOT))+$/i, "")
  const normalized = normalizeIdentity(trimmed)
  if (normalized.length < 5 || !/[A-Z]/.test(normalized) || !/\d/.test(normalized)) return
  if (/^(?:CORTEX|ARM|THUMB|DEBUG|RELEASE)/.test(normalized)) return
  return trimmed
}

/**
 * Turn broad lexical evidence into hardware-target choices.
 *
 * Discovery intentionally keeps a wide evidence net, but user-facing target
 * choices must be much stricter: project names, peripheral symbols and
 * companion devices are evidence context, not alternative MCU models.
 */
export function rankTargetCandidates(
  projectDir: string,
  evidence: LocalTargetEvidence[],
  declaredChip?: string,
): RankedTargetCandidate[] {
  const projectIdentities = new Set([
    basename(projectDir),
    loadProjectName(projectDir),
  ].map(normalizeIdentity).filter(Boolean))
  const candidates = new Map<string, {
    model: string
    score: number
    sources: Set<string>
    explicitlyDeclared: boolean
    mainControllerEvidence: boolean
  }>()

  const add = (
    model: string,
    score: number,
    source: string,
    flags?: { declared?: boolean; mainController?: boolean },
  ) => {
    const normalized = normalizeIdentity(model)
    if (!normalized || (!flags?.declared && !isPlausibleTargetModel(model, normalized, projectIdentities))) return
    const current = candidates.get(normalized) ?? {
      model,
      score: 0,
      sources: new Set<string>(),
      explicitlyDeclared: false,
      mainControllerEvidence: false,
    }
    // Multiple independent sources increase confidence without allowing a
    // repeated token in one large document to dominate the ranking.
    if (!current.sources.has(source)) current.score += score
    current.sources.add(source)
    current.explicitlyDeclared ||= Boolean(flags?.declared)
    current.mainControllerEvidence ||= Boolean(flags?.mainController)
    candidates.set(normalized, current)
  }

  if (declaredChip?.trim()) {
    add(declaredChip.trim(), 160, ".eval/project.toml", { declared: true, mainController: true })
  }

  for (const item of evidence) {
    const excerpt = item.excerpt ?? ""
    const verified = /^(?:PASS|VERIFIED|CONSISTENT)$/i.test(item.verification ?? "")
    for (const model of item.candidates) {
      const mainController = hasMainControllerRelation(excerpt, model)
      const companion = hasCompanionRelation(excerpt, model)
      const fileNamed = candidateTokens(basename(item.source))
        .some((token) => normalizeIdentity(stripEvidenceFilePrefix(token)) === normalizeIdentity(model))
      let score = item.kind === "datasheet" ? 36
        : item.kind === "schematic" ? 28
          : item.kind === "build-definition" ? 18
            : 12
      if (fileNamed) score += 24
      if (mainController) score += 80
      if (verified && mainController) score += 28
      if (companion && !mainController) score -= 90
      add(model, score, `${item.kind}:${item.source}`, { mainController })
    }
  }

  return [...candidates.values()]
    .filter((item) => item.explicitlyDeclared || item.mainControllerEvidence || item.score >= 45)
    .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model))
    .map((item) => ({ ...item, sources: [...item.sources] }))
}

/**
 * Produce concise confirmation options. A declared project target is the
 * primary candidate; unrelated lexical tokens never compete with it. A
 * genuinely conflicting, independently identified controller is still shown.
 */
export function targetConfirmationOptions(
  projectDir: string,
  evidence: LocalTargetEvidence[],
  declaredChip?: string,
): string[] {
  const ranked = rankTargetCandidates(projectDir, evidence, declaredChip)
  const declared = ranked.find((item) => item.explicitlyDeclared)
  if (declared) {
    const conflicts = ranked.filter((item) =>
      !item.explicitlyDeclared
      && item.mainControllerEvidence
      && item.score >= 80
      && normalizeIdentity(item.model) !== normalizeIdentity(declared.model))
    return [declared.model, ...conflicts.map((item) => item.model)].slice(0, 3)
  }
  if (ranked.length === 0) return []
  const strongest = ranked[0]!
  const close = ranked.filter((item, index) =>
    index === 0 || (item.mainControllerEvidence && strongest.score - item.score <= 20))
  return close.slice(0, 3).map((item) => item.model)
}

function walk(dir: string, out: string[], depth: number): void {
  if (depth > 5 || out.length >= 500 || !existsSync(dir)) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= 500) return
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name.toLowerCase())) walk(path, out, depth + 1)
    } else if (entry.isFile()) {
      out.push(path)
    }
  }
}

export function candidateTokens(text: string): string[] {
  const found = new Set<string>()
  // Candidate syntax is intentionally broad and vendor-neutral. Confirmation
  // comes from the user, not this lexical detector.
  for (const match of text.matchAll(/\b(?=[A-Z0-9_-]{5,32}\b)(?=[A-Z0-9_-]*[A-Z])(?=[A-Z0-9_-]*\d)[A-Z][A-Z0-9_-]+\b/g)) {
    const token = match[0]
    if (!/^(?:GPIO|USART|UART|SPI|I2C|ADC|FLASH|DEBUG|BUILD|CMAKE|CROSS|COMPILE|ENABLE|DISABLE|OUTPUT)$/i.test(token)) {
      found.add(token)
    }
  }
  return [...found].slice(0, 40)
}

function hashFile(path: string): string | undefined {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) return
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return
  }
}

function artifactVerification(metadata: Record<string, unknown>): string | undefined {
  const verification = metadata.verification
  if (verification && typeof verification === "object") {
    const verdict = (verification as Record<string, unknown>).verdict
    if (typeof verdict === "string") return verdict
  }
  if (metadata.usableForMapping === true) return "VERIFIED"
  if (metadata.usableForMapping === false) return "REVIEW_REQUIRED"
  return
}

function normalizeIdentity(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function isPlausibleTargetModel(value: string, normalized: string, projectIdentities: Set<string>): boolean {
  if (projectIdentities.has(normalized)) return false
  if (!/[A-Z]/i.test(value) || !/\d/.test(value)) return false
  if (/^(?:EXTI|IRQ|GPIO|ADC|DAC|TIM|PWM|UART|USART|SPI|I2C|I3C|CAN|USB|SWD|JTAG|DMA|PIN|PORT|CH)\d/i.test(normalized)) {
    return false
  }
  if (/(?:_IRQn|_HANDLER|_CHANNEL|_PIN|_MODE|_ENABLE|_DISABLE)$/i.test(value)) return false
  return true
}

function hasMainControllerRelation(excerpt: string, model: string): boolean {
  if (!excerpt) return false
  const escaped = escapeRegExp(model)
  return new RegExp(
    `(?:主控(?:芯片)?(?:完整)?型号|\\bMCU(?:\\s+(?:model|part))?|\\btarget(?:\\s+chip)?|\\bchip(?:\\s+model)?)\\s*(?:为|是|[:=：-])?\\s*[^，。；;()（）+＋\\r\\n]{0,48}?\\b${escaped}\\b`,
    "i",
  ).test(excerpt)
}

function hasCompanionRelation(excerpt: string, model: string): boolean {
  if (!excerpt) return false
  const escaped = escapeRegExp(model)
  return new RegExp(`\\b${escaped}\\b[^\\r\\n]{0,24}(?:AFE|传感器|sensor|前端|外设|peripheral|中断|interrupt)\\b`, "i")
    .test(excerpt)
}

function loadProjectName(projectDir: string): string {
  try {
    const configPath = join(projectDir, ".eval", "project.toml")
    const raw = readFileSync(configPath, "utf8")
    return raw.match(/^\s*name\s*=\s*["']?([^"'#\r\n]+)["']?/im)?.[1]?.trim() ?? ""
  } catch {
    return ""
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stripEvidenceFilePrefix(value: string): string {
  return value.replace(/^(?:SCH|SCHEMATIC|DATASHEET|DS|DOC|MANUAL)[_-]+/i, "")
}
