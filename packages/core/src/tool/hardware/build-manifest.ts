import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
import { analyzeFirmwareArtifact } from "./firmware-artifact"
import type {
  BuildArtifactFormat,
  BuildArtifactOutcome,
  BuildProcessOutcome,
  BuildRequest,
  BuildRunManifest,
  DownloadEligibility,
  ProgrammingBundle,
} from "./build-types"

const ARTIFACT_EXTENSIONS = new Map<string, BuildArtifactFormat>([
  [".elf", "elf"],
  [".hex", "hex"],
  [".bin", "bin"],
])
const MAX_DEPTH = 5

export interface ArtifactSnapshot {
  path: string
  sha256: string
}

export function snapshotBuildArtifacts(buildDir: string): Map<string, ArtifactSnapshot> {
  const result = new Map<string, ArtifactSnapshot>()
  for (const path of findArtifactCandidates(buildDir)) {
    result.set(resolve(path), { path: resolve(path), sha256: sha256File(path) })
  }
  return result
}

export async function resolveBuildArtifacts(
  request: BuildRequest,
  before: Map<string, ArtifactSnapshot>,
): Promise<BuildArtifactOutcome[]> {
  const previous = loadLatestSuccessfulBuildManifest(request.projectRoot)
  const reusable = previous?.request.inputFingerprint === request.inputFingerprint
    ? new Map(previous.artifacts.map((artifact) => [resolve(artifact.path), artifact]))
    : new Map<string, BuildArtifactOutcome>()
  const outcomes: BuildArtifactOutcome[] = []
  for (const path of findArtifactCandidates(request.buildDir)) {
    const absolute = resolve(path)
    const sha256 = sha256File(absolute)
    const prior = before.get(absolute)
    const freshness = !prior || prior.sha256 !== sha256
      ? "produced" as const
      : reusable.get(absolute)?.sha256 === sha256
        ? "verified-reuse" as const
        : undefined
    if (!freshness) continue
    const format = ARTIFACT_EXTENSIONS.get(extname(absolute).toLowerCase())!
    if (format === "hex") {
      const artifact = await analyzeFirmwareArtifact(absolute)
      outcomes.push({
        path: absolute,
        relativePath: relative(request.projectRoot, absolute),
        format,
        freshness,
        valid: artifact.valid,
        fileBytes: artifact.fileBytes,
        sha256: artifact.sha256,
        programmedBytes: artifact.programmedBytes,
        addressStart: artifact.addressStart,
        addressEnd: artifact.addressEnd,
        diagnostics: artifact.diagnostics,
      })
      continue
    }
    outcomes.push({
      path: absolute,
      relativePath: relative(request.projectRoot, absolute),
      format,
      freshness,
      valid: true,
      fileBytes: statSync(absolute).size,
      sha256,
      diagnostics: [],
    })
  }
  return outcomes.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

export function determineDownloadEligibility(
  request: BuildRequest,
  _artifacts: BuildArtifactOutcome[],
  programming?: ProgrammingBundle,
): DownloadEligibility {
  const blockers: string[] = []
  if (request.buildSystem !== "idf") {
    return {
      eligible: false,
      blockers: ["Eval 内置固件下载仅支持 ESP-IDF 工程；其他芯片请使用厂商工具手动下载"],
    }
  }
  if (!programming) blockers.push("ESP-IDF 未产生可认证的 flasher_args.json 多镜像下载清单")
  return {
    eligible: blockers.length === 0,
    provider: "esptool",
    bundleId: programming?.bundleId,
    blockers,
  }
}

export function saveBuildManifest(manifest: BuildRunManifest): void {
  const directory = join(manifest.request.projectRoot, ".eval", "build-runs")
  mkdirSync(directory, { recursive: true })
  writeJsonAtomic(join(directory, `${manifest.request.requestId}.json`), manifest)
  writeJsonAtomic(join(directory, "latest.json"), manifest)
  if (manifest.process.status === "succeeded") {
    writeJsonAtomic(join(directory, "latest-success.json"), manifest)
  }
}

export function loadLatestBuildManifest(projectRoot: string): BuildRunManifest | undefined {
  return loadManifest(projectRoot, "latest.json")
}

export function loadLatestSuccessfulBuildManifest(projectRoot: string): BuildRunManifest | undefined {
  const manifest = loadManifest(projectRoot, "latest-success.json")
  return manifest?.process.status === "succeeded" ? manifest : undefined
}

function loadManifest(projectRoot: string, name: string): BuildRunManifest | undefined {
  const path = join(projectRoot, ".eval", "build-runs", name)
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as BuildRunManifest
    if (value.schemaVersion !== 1 || value.request?.schemaVersion !== 1 || !Array.isArray(value.artifacts)) return undefined
    if (resolve(value.request.projectRoot) !== resolve(projectRoot)) return undefined
    return value
  } catch {
    return undefined
  }
}

export function buildManifest(
  request: BuildRequest,
  process: BuildProcessOutcome,
  artifacts: BuildArtifactOutcome[],
  sections?: BuildRunManifest["sections"],
): BuildRunManifest {
  const programming = resolveProgrammingBundle(request, artifacts)
  return {
    schemaVersion: 1,
    request,
    process,
    artifacts,
    programming,
    download: determineDownloadEligibility(request, artifacts, programming),
    sections,
  }
}

/** Parse only ESP-IDF's generated flasher manifest; addresses are never inferred from filenames. */
export function resolveProgrammingBundle(
  request: BuildRequest,
  artifacts: BuildArtifactOutcome[],
): ProgrammingBundle | undefined {
  if (request.buildSystem !== "idf") return undefined
  const manifestPath = join(request.buildDir, "flasher_args.json")
  if (!existsSync(manifestPath)) return undefined
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      flash_files?: Record<string, string>
      flash_settings?: Record<string, unknown>
      extra_esptool_args?: Record<string, unknown>
    }
    if (!raw.flash_files || typeof raw.flash_files !== "object") return undefined
    const declared = new Map(artifacts.filter((item) => item.format === "bin" && item.valid)
      .map((item) => [resolve(item.path), item]))
    const images = Object.entries(raw.flash_files).map(([address, file]) => {
      if (typeof file !== "string" || !/^(?:0x)?[0-9a-f]+$/i.test(address)) throw new Error("ESP 下载地址格式无效")
      const offset = Number.parseInt(address.replace(/^0x/i, ""), 16)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0xffff_ffff) throw new Error("ESP 下载地址超出范围")
      const path = requireFileInside(request.buildDir, file)
      const artifact = declared.get(path)
      if (!artifact || artifact.sha256 !== sha256File(path)) throw new Error("ESP 固件不属于本次认证构建")
      return {
        path,
        relativePath: relative(request.projectRoot, path),
        offset,
        fileBytes: artifact.fileBytes,
        sha256: artifact.sha256,
      }
    }).sort((a, b) => a.offset - b.offset)
    if (images.length === 0) return undefined
    for (let index = 1; index < images.length; index++) {
      const previous = images[index - 1]
      if (previous.offset + previous.fileBytes > images[index].offset) throw new Error("ESP 固件镜像地址范围重叠")
    }
    const chip = stringValue(raw.extra_esptool_args?.chip) ?? request.platformTarget
    if (!chip || !/^[a-z0-9-]{3,32}$/i.test(chip)) throw new Error("ESP 固件清单缺少有效芯片 target")
    if (request.platformTarget && chip.toLowerCase() !== request.platformTarget.toLowerCase()) {
      throw new Error("ESP 固件清单芯片与项目 target 不一致")
    }
    const identity = createHash("sha256")
    identity.update(chip)
    for (const image of images) identity.update(`${image.offset}:${image.sha256}`)
    return {
      bundleId: identity.digest("hex"),
      provider: "esptool",
      chip: chip.toLowerCase(),
      images,
      flashSettings: {
        flashMode: stringValue(raw.flash_settings?.flash_mode),
        flashFreq: stringValue(raw.flash_settings?.flash_freq),
        flashSize: stringValue(raw.flash_settings?.flash_size),
      },
    }
  } catch {
    return undefined
  }
}

function requireFileInside(root: string, value: string): string {
  const path = resolve(root, value)
  const rel = relative(root, path)
  if (rel.startsWith("..") || resolve(root, rel) !== path) throw new Error("ESP 固件路径越出构建目录")
  if (!existsSync(path) || extname(path).toLowerCase() !== ".bin") throw new Error("ESP 固件文件不存在或格式无效")
  return path
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function findArtifactCandidates(root: string): string[] {
  if (!existsSync(root)) return []
  const result: string[] = []
  const visit = (directory: string, depth: number) => {
    if (depth < 0) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path, depth - 1)
      else if (entry.isFile() && ARTIFACT_EXTENSIONS.has(extname(entry.name).toLowerCase())) result.push(path)
    }
  }
  visit(root, MAX_DEPTH)
  return result
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  renameSync(temporary, path)
}
