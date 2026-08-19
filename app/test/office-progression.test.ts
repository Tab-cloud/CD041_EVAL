import { beforeEach, describe, expect, test } from "bun:test"
import {
  awardOfficeCompletion, earnedOfficeFurnitureIds, loadOfficeProgression, officeLevel,
  officeLevelProgress,
} from "../src/office/office-progression"
import { planOfficeRoute, routeDirection } from "../src/office/office-navigation"

const values = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  },
})

describe("Office Game Loop 1.0", () => {
  beforeEach(() => values.clear())

  test("rewards a real completion exactly once", () => {
    const first = awardOfficeCompletion("run-1", new Date(2026, 6, 18, 10).getTime())
    expect(first?.xp).toBe(40)
    expect(first?.researchPoints).toBe(12)
    expect(first?.unlockedAchievementIds).toContain("first-delivery")
    expect(awardOfficeCompletion("run-1", new Date(2026, 6, 18, 11).getTime())).toBeNull()
    expect(loadOfficeProgression().completedTasks).toBe(1)
  })

  test("tracks a daily streak and level furniture rewards", () => {
    awardOfficeCompletion("run-1", new Date(2026, 6, 18, 10).getTime())
    awardOfficeCompletion("run-2", new Date(2026, 6, 19, 10).getTime())
    const third = awardOfficeCompletion("run-3", new Date(2026, 6, 20, 10).getTime())
    const progress = loadOfficeProgression()
    expect(progress.streakDays).toBe(3)
    expect(third?.unlockedAchievementIds).toContain("three-day-streak")
    expect(officeLevel(progress.xp)).toBeGreaterThanOrEqual(2)
    expect(earnedOfficeFurnitureIds(progress)).toContain("debug-duck")
    expect(officeLevelProgress(progress.xp).percent).toBeGreaterThanOrEqual(0)
  })

  test("routes long movement through stable office corridors", () => {
    const route = planOfficeRoute({ x: 12, y: 20 }, { x: 88, y: 76 })
    expect(route.length).toBeGreaterThan(1)
    expect(route.at(-1)).toEqual({ x: 88, y: 76 })
    expect(routeDirection({ x: 30, y: 50 }, { x: 60, y: 50 })).toBe("right")
    expect(routeDirection({ x: 60, y: 50 }, { x: 30, y: 50 })).toBe("left")
  })
})
