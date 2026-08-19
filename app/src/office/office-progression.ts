import type { OfficeProgression } from "./types"

const STORAGE_KEY = "eval_office_progression_v1"
const CHANGE_EVENT = "eval-office-progression-changed"

export interface OfficeAchievement {
  id: string
  name: string
  description: string
  threshold: number
  metric: "completedTasks" | "streakDays"
}

export interface OfficeCompletionReward {
  xp: number
  researchPoints: number
  levelBefore: number
  levelAfter: number
  unlockedAchievementIds: string[]
  unlockedFurnitureIds: string[]
}

export const OFFICE_ACHIEVEMENTS: OfficeAchievement[] = [
  { id: "first-delivery", name: "第一次交付", description: "完成首个真实 Agent 任务", threshold: 1, metric: "completedTasks" },
  { id: "steady-builder", name: "稳定建造者", description: "累计完成 5 个任务", threshold: 5, metric: "completedTasks" },
  { id: "deep-work", name: "深度工作室", description: "累计完成 20 个任务", threshold: 20, metric: "completedTasks" },
  { id: "three-day-streak", name: "连续开工", description: "连续 3 天完成任务", threshold: 3, metric: "streakDays" },
]

const LEVEL_THRESHOLDS = [0, 100, 240, 450, 720, 1_050, 1_450, 1_920, 2_460, 3_070]
const LEVEL_FURNITURE: Record<number, string> = { 2: "debug-duck", 3: "commit-board", 5: "release-trophy" }

const DEFAULT_PROGRESS: OfficeProgression = {
  version: 1, xp: 0, researchPoints: 0, completedTasks: 0, streakDays: 0,
  rewardedRunIds: [], unlockedAchievementIds: [],
}

export function loadOfficeProgression(): OfficeProgression {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<OfficeProgression>
    return {
      version: 1,
      xp: safeNumber(value.xp), researchPoints: safeNumber(value.researchPoints),
      completedTasks: safeNumber(value.completedTasks), streakDays: safeNumber(value.streakDays),
      lastCompletionDate: typeof value.lastCompletionDate === "string" ? value.lastCompletionDate : undefined,
      rewardedRunIds: strings(value.rewardedRunIds).slice(-300),
      unlockedAchievementIds: strings(value.unlockedAchievementIds),
    }
  } catch { return { ...DEFAULT_PROGRESS } }
}

export function awardOfficeCompletion(runId: string, timestamp = Date.now()): OfficeCompletionReward | null {
  const current = loadOfficeProgression()
  if (!runId || current.rewardedRunIds.includes(runId)) return null
  const levelBefore = officeLevel(current.xp)
  const date = localDate(timestamp)
  const streakDays = nextStreak(current.lastCompletionDate, date, current.streakDays)
  const xp = 35 + Math.min(levelBefore * 5, 25)
  const researchPoints = 10 + Math.min(levelBefore * 2, 10)
  const candidate: OfficeProgression = {
    ...current,
    xp: current.xp + xp,
    researchPoints: current.researchPoints + researchPoints,
    completedTasks: current.completedTasks + 1,
    streakDays,
    lastCompletionDate: date,
    rewardedRunIds: [...current.rewardedRunIds, runId].slice(-300),
  }
  const unlockedAchievementIds = OFFICE_ACHIEVEMENTS
    .filter((item) => candidate[item.metric] >= item.threshold && !current.unlockedAchievementIds.includes(item.id))
    .map((item) => item.id)
  candidate.unlockedAchievementIds = [...current.unlockedAchievementIds, ...unlockedAchievementIds]
  const levelAfter = officeLevel(candidate.xp)
  const unlockedFurnitureIds = Object.entries(LEVEL_FURNITURE)
    .filter(([level]) => Number(level) > levelBefore && Number(level) <= levelAfter)
    .map(([, itemId]) => itemId)
  saveOfficeProgression(candidate)
  return { xp, researchPoints, levelBefore, levelAfter, unlockedAchievementIds, unlockedFurnitureIds }
}

export function saveOfficeProgression(progress: OfficeProgression): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress))
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

export function subscribeOfficeProgression(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}

export function officeLevel(xp: number): number {
  for (let index = LEVEL_THRESHOLDS.length - 1; index >= 0; index--) if (xp >= LEVEL_THRESHOLDS[index]) return index + 1
  return 1
}

export function officeLevelProgress(xp: number): { current: number; required: number; percent: number } {
  const level = officeLevel(xp)
  const start = LEVEL_THRESHOLDS[level - 1] ?? LEVEL_THRESHOLDS.at(-1) ?? 0
  const end = LEVEL_THRESHOLDS[level] ?? start + 700
  const current = Math.max(0, xp - start)
  const required = Math.max(1, end - start)
  return { current, required, percent: Math.min(100, Math.round(current / required * 100)) }
}

export function earnedOfficeFurnitureIds(progress: OfficeProgression): string[] {
  const level = officeLevel(progress.xp)
  return Object.entries(LEVEL_FURNITURE).filter(([required]) => level >= Number(required)).map(([, itemId]) => itemId)
}

function nextStreak(previous: string | undefined, current: string, currentStreak: number): number {
  if (!previous) return 1
  if (previous === current) return Math.max(1, currentStreak)
  const previousDate = new Date(`${previous}T00:00:00`)
  previousDate.setDate(previousDate.getDate() + 1)
  return localDate(previousDate.getTime()) === current ? Math.max(1, currentStreak + 1) : 1
}

function localDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
function safeNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0 }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [] }
