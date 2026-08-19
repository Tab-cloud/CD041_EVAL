export type BuildSystem = "cmake" | "makefile" | "idf"
export type BuildMode = "incremental" | "rebuild" | "clean"
export type BuildPhase = "resolve" | "configure" | "clean" | "build" | "post-process" | "verify" | "complete"
export type BuildStreamType = "stdout" | "stderr" | "info"

export interface BuildTargetSnapshot {
  model: string
  family: string
  evidence: string
}

/** Immutable input for one build execution. */
export interface BuildRequest {
  schemaVersion: 1
  requestId: string
  createdAt: string
  projectDir: string
  projectRoot: string
  projectName: string
  buildDir: string
  buildSystem: BuildSystem
  buildSystemSource: "project-config" | "auto-detection"
  mode: BuildMode
  target: string
  jobs: number
  timeoutMs: number
  toolchain: string
  configurePreset?: string
  buildPreset?: string
  generator?: string
  toolchainFile?: string
  platformTarget?: string
  targetSnapshot: BuildTargetSnapshot
  inputFingerprint: string
}

export interface BuildEvent {
  requestId: string
  phase: BuildPhase
  type: BuildStreamType
  text: string
  timestamp: number
}

export interface BuildDiagnostic {
  severity: "error" | "warning"
  message: string
  file?: string
  line?: number
  column?: number
}

export interface BuildProcessOutcome {
  status: "succeeded" | "failed" | "cancelled" | "timed-out"
  exitCode?: number
  commands: Array<{ phase: BuildPhase; command: string[] }>
  startedAt: string
  finishedAt: string
  durationMs: number
  diagnostics: BuildDiagnostic[]
  stdoutTail: string
  stderrTail: string
}

export type BuildArtifactFormat = "elf" | "hex" | "bin"

export interface BuildArtifactOutcome {
  path: string
  relativePath: string
  format: BuildArtifactFormat
  freshness: "produced" | "verified-reuse"
  valid: boolean
  fileBytes: number
  sha256: string
  programmedBytes?: number
  addressStart?: number
  addressEnd?: number
  diagnostics: Array<{ severity: "error" | "warning"; message: string }>
}

export interface DownloadEligibility {
  eligible: boolean
  provider?: "esptool"
  bundleId?: string
  blockers: string[]
}

export interface ProgrammingImage {
  path: string
  relativePath: string
  offset: number
  fileBytes: number
  sha256: string
}

export interface ProgrammingBundle {
  bundleId: string
  provider: "esptool"
  chip: string
  images: ProgrammingImage[]
  flashSettings: {
    flashMode?: string
    flashFreq?: string
    flashSize?: string
  }
}

export interface BuildRunManifest {
  schemaVersion: 1
  request: BuildRequest
  process: BuildProcessOutcome
  artifacts: BuildArtifactOutcome[]
  programming?: ProgrammingBundle
  download: DownloadEligibility
  sections?: { text?: string; data?: string; bss?: string; total?: string }
}
