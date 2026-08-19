import type { OfficePoint } from "./types"

export type OfficeAvatarDirection = "left" | "right" | "front" | "back"
export type OfficeAvatarRuntimePhase = "walking" | "rising" | "aligning" | "turning" | "sitting" | "seated" | "standing"

export interface OfficeAvatarRuntimeState {
  sessionId: string
  runId: string
  position: OfficePoint
  target: OfficePoint
  direction: OfficeAvatarDirection
  gaitStep: 0 | 1
  phase: OfficeAvatarRuntimePhase
  traveling: boolean
  updatedAt: number
}

const STORAGE_KEY = "eval_office_avatar_runtime_v1"
const MAX_STATES = 96
const MAX_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const WRITE_INTERVAL_MS = 400

const states = new Map<string, OfficeAvatarRuntimeState>()
let hydrated = false
let flushTimer: ReturnType<typeof setTimeout> | null = null
let lastWriteAt = 0

export function loadOfficeAvatarRuntime(sessionId: string, runId: string): OfficeAvatarRuntimeState | null {
  hydrate()
  const value = states.get(runtimeKey(sessionId, runId))
  return value ? cloneState(value) : null
}

export function saveOfficeAvatarRuntime(state: OfficeAvatarRuntimeState): void {
  hydrate()
  const normalized = normalizeState(state)
  if (!normalized) return
  states.set(runtimeKey(normalized.sessionId, normalized.runId), normalized)
  pruneStates(normalized.updatedAt)
  scheduleFlush()
}

export function flushOfficeAvatarRuntime(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const target = runtimeStorage()
  if (!target) return
  try {
    target.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      states: [...states.values()],
    }))
    lastWriteAt = Date.now()
  } catch {
    // Runtime continuity is best-effort; the in-memory simulation remains authoritative.
  }
}

export function clearOfficeAvatarRuntimeSession(sessionId: string): void {
  hydrate()
  for (const [key, value] of states) {
    if (value.sessionId === sessionId) states.delete(key)
  }
  scheduleFlush()
}

/** Test-only reset kept explicit so runtime continuity tests never share process state. */
export function resetOfficeAvatarRuntimeForTests(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  states.clear()
  hydrated = true
  lastWriteAt = 0
}

function hydrate(): void {
  if (hydrated) return
  hydrated = true
  const source = runtimeStorage()
  if (!source) return
  try {
    const payload = JSON.parse(source.getItem(STORAGE_KEY) ?? "") as { version?: number; states?: unknown[] }
    if (payload.version !== 1 || !Array.isArray(payload.states)) return
    for (const candidate of payload.states) {
      const state = normalizeState(candidate)
      if (state) states.set(runtimeKey(state.sessionId, state.runId), state)
    }
    pruneStates(Date.now())
  } catch {
    // Ignore malformed or legacy runtime snapshots.
  }
}

function scheduleFlush(): void {
  const elapsed = Date.now() - lastWriteAt
  if (elapsed >= WRITE_INTERVAL_MS) {
    flushOfficeAvatarRuntime()
    return
  }
  if (flushTimer) return
  flushTimer = setTimeout(flushOfficeAvatarRuntime, WRITE_INTERVAL_MS - elapsed)
}

function pruneStates(now: number): void {
  for (const [key, value] of states) {
    if (now - value.updatedAt > MAX_STATE_AGE_MS) states.delete(key)
  }
  if (states.size <= MAX_STATES) return
  const oldest = [...states.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  for (const [key] of oldest.slice(0, states.size - MAX_STATES)) states.delete(key)
}

function normalizeState(value: unknown): OfficeAvatarRuntimeState | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<OfficeAvatarRuntimeState>
  if (!candidate.sessionId || !candidate.runId || !validPoint(candidate.position) || !validPoint(candidate.target)) return null
  if (!["left", "right", "front", "back"].includes(candidate.direction ?? "")) return null
  if (![0, 1].includes(candidate.gaitStep as number)) return null
  if (!["walking", "rising", "aligning", "turning", "sitting", "seated", "standing"].includes(candidate.phase ?? "")) return null
  if (typeof candidate.traveling !== "boolean" || !Number.isFinite(candidate.updatedAt)) return null
  return {
    sessionId: candidate.sessionId,
    runId: candidate.runId,
    position: clampPoint(candidate.position),
    target: clampPoint(candidate.target),
    direction: candidate.direction as OfficeAvatarDirection,
    gaitStep: candidate.gaitStep as 0 | 1,
    phase: candidate.phase as OfficeAvatarRuntimePhase,
    traveling: candidate.traveling,
    updatedAt: candidate.updatedAt!,
  }
}

function runtimeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function runtimeKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId}`
}

function validPoint(value: unknown): value is OfficePoint {
  if (!value || typeof value !== "object") return false
  const point = value as Partial<OfficePoint>
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function clampPoint(point: OfficePoint): OfficePoint {
  return {
    x: Math.max(0, Math.min(100, point.x)),
    y: Math.max(0, Math.min(100, point.y)),
  }
}

function cloneState(state: OfficeAvatarRuntimeState): OfficeAvatarRuntimeState {
  return {
    ...state,
    position: { ...state.position },
    target: { ...state.target },
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushOfficeAvatarRuntime)
}
