import type { OfficeAppearance, OfficeFestival, OfficeFurniturePlacement, OfficePoint, OfficePreferences } from "./types"

const SCENE_SCHEMA_VERSION = 4
const STORAGE_KEY = "eval_digital_office_preferences_v4"
const LEGACY_STORAGE_KEYS = ["eval_digital_office_preferences_v3", "eval_digital_office_preferences_v2"]

const DEFAULT_PREFERENCES: OfficePreferences = {
  sceneSchemaVersion: SCENE_SCHEMA_VERSION,
  positions: {},
  zonePositions: {},
  appearances: {},
  festival: "auto",
  activePackId: "classic",
  furniture: [],
}

export function loadOfficePreferences(): OfficePreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
      ?? LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find(Boolean)
      ?? "{}"
    const value = JSON.parse(stored) as Partial<OfficePreferences>
    const currentScene = value.sceneSchemaVersion === SCENE_SCHEMA_VERSION
    return {
      sceneSchemaVersion: SCENE_SCHEMA_VERSION,
      // Furniture moved from the painted background into physical scene nodes.
      // Legacy coordinates must not be applied to the new geometry.
      positions: currentScene ? validPoints(value.positions) : {},
      zonePositions: currentScene ? validPoints(value.zonePositions) : {},
      appearances: value.appearances && typeof value.appearances === "object" ? value.appearances : {},
      festival: isFestival(value.festival) ? value.festival : "auto",
      activePackId: typeof value.activePackId === "string" ? value.activePackId : "classic",
      furniture: validFurniture(value.furniture),
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function saveOfficePreferences(preferences: OfficePreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

export function setAgentPosition(preferences: OfficePreferences, agentId: string, point: OfficePoint): OfficePreferences {
  return { ...preferences, positions: { ...preferences.positions, [agentId]: clampPoint(point) } }
}

export function setZonePosition(preferences: OfficePreferences, zoneId: string, point: OfficePoint): OfficePreferences {
  return { ...preferences, zonePositions: { ...preferences.zonePositions, [zoneId]: clampPoint(point) } }
}

export function setAgentAppearance(preferences: OfficePreferences, agentId: string, appearance: OfficeAppearance): OfficePreferences {
  return { ...preferences, appearances: { ...preferences.appearances, [agentId]: appearance } }
}

export function setActiveOfficePack(preferences: OfficePreferences, activePackId: string): OfficePreferences {
  return { ...preferences, activePackId, zonePositions: {} }
}

export function addOfficeFurniture(preferences: OfficePreferences, placement: OfficeFurniturePlacement): OfficePreferences {
  return { ...preferences, furniture: [...preferences.furniture, placement] }
}

export function moveOfficeFurniture(preferences: OfficePreferences, instanceId: string, point: OfficePoint): OfficePreferences {
  return { ...preferences, furniture: preferences.furniture.map((item) => item.instanceId === instanceId ? { ...item, ...clampPoint(point) } : item) }
}

export function removeOfficeFurniture(preferences: OfficePreferences, instanceId: string): OfficePreferences {
  return { ...preferences, furniture: preferences.furniture.filter((item) => item.instanceId !== instanceId) }
}

export function resetOfficeLayout(preferences: OfficePreferences): OfficePreferences {
  return { ...preferences, positions: {}, zonePositions: {}, furniture: [] }
}

export function resolveFestival(value: OfficeFestival, date = new Date(), allowLunar = true): Exclude<OfficeFestival, "auto"> {
  if (value !== "auto") return value === "lunar" && !allowLunar ? "none" : value
  const month = date.getMonth() + 1
  const day = date.getDate()
  if ((month === 1 && day >= 20) || (month === 2 && day <= 20)) return allowLunar ? "lunar" : "winter"
  if (month >= 3 && month <= 5) return "spring"
  if (month >= 6 && month <= 8) return "summer"
  if (month >= 9 && month <= 11) return "autumn"
  return "winter"
}

export function officeDayPhase(date = new Date()): "day" | "dusk" | "night" {
  const hour = date.getHours()
  if (hour >= 7 && hour < 18) return "day"
  if (hour >= 18 && hour < 21) return "dusk"
  return "night"
}

function clampPoint(point: OfficePoint): OfficePoint {
  return { x: Math.max(5, Math.min(95, point.x)), y: Math.max(12, Math.min(78, point.y)) }
}

function validPoints(input: unknown): Record<string, OfficePoint> {
  if (!input || typeof input !== "object") return {}
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    const point = value as Partial<OfficePoint>
    return Number.isFinite(point.x) && Number.isFinite(point.y)
  }).map(([key, value]) => [key, clampPoint(value as OfficePoint)]))
}

function validFurniture(input: unknown): OfficeFurniturePlacement[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((value) => {
    const item = value as Partial<OfficeFurniturePlacement>
    if (typeof item.instanceId !== "string" || typeof item.itemId !== "string" || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return []
    const rotation = [0, 90, 180, 270].includes(Number(item.rotation)) ? item.rotation as OfficeFurniturePlacement["rotation"] : 0
    return [{ instanceId: item.instanceId, itemId: item.itemId, ...clampPoint(item as OfficePoint), rotation }]
  })
}

function isFestival(value: unknown): value is OfficeFestival {
  return ["auto", "none", "spring", "summer", "autumn", "winter", "lunar"].includes(String(value))
}
