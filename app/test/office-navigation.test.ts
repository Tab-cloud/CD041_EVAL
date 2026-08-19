import { describe, expect, test } from "bun:test"
import { agentPosition } from "../src/office/office-model"
import { DEFAULT_OFFICE_BOUNDS, isOfficePointWalkable, nearestWalkablePoint, OFFICE_AGENT_RADIUS, planOfficeRoute, resolveOfficeObstacles, resolvePlacedFurnitureObstacles, type OfficeObstacle } from "../src/office/office-navigation"
import { OFFICE_THEME_PACKS, resolveOfficeScenePositions } from "../src/office/office-packs"
import { resolveSceneObjectObstacles } from "../src/office/office-scene-objects"
import type { OfficeActivity, OfficePoint } from "../src/office/types"

describe("Office collision navigation", () => {
  test("routes around furniture without sampling a blocked point", () => {
    const obstacle: OfficeObstacle = { id: "desk", x: 40, y: 30, width: 20, height: 24 }
    const route = planOfficeRoute({ x: 20, y: 40 }, { x: 80, y: 40 }, { obstacles: [obstacle] })
    expect(route.length).toBeGreaterThan(2)
    assertRouteWalkable({ x: 20, y: 40 }, route, [obstacle])
  })

  test("relocates a destination requested on top of a desk", () => {
    const obstacle: OfficeObstacle = { id: "desk", x: 40, y: 30, width: 20, height: 24 }
    const route = planOfficeRoute({ x: 20, y: 40 }, { x: 50, y: 40 }, { obstacles: [obstacle] })
    const destination = route.at(-1)
    expect(destination).toBeDefined()
    expect(isOfficePointWalkable(destination!, [obstacle])).toBe(true)
    assertRouteWalkable({ x: 20, y: 40 }, route, [obstacle])
  })

  test("keeps the full employee capsule outside a furniture edge", () => {
    const obstacle: OfficeObstacle = { id: "desk", x: 40, y: 30, width: 20, height: 24 }
    expect(isOfficePointWalkable({ x: 61, y: 40 }, [obstacle])).toBe(true)
    expect(isOfficePointWalkable({ x: 61, y: 40 }, [obstacle], undefined, OFFICE_AGENT_RADIUS)).toBe(false)
  })

  test("treats placed furniture as obstacles while keeping rugs walkable", () => {
    const obstacles = resolvePlacedFurnitureObstacles([
      { instanceId: "server-1", itemId: "mini-server", x: 50, y: 50, rotation: 0 },
      { instanceId: "rug-1", itemId: "blueprint-rug", x: 70, y: 70, rotation: 0 },
    ])
    expect(obstacles.map((value) => value.id)).toEqual(["furniture:server-1"])
    expect(isOfficePointWalkable({ x: 50, y: 50 }, obstacles)).toBe(false)
    expect(isOfficePointWalkable({ x: 70, y: 70 }, obstacles)).toBe(true)
  })

  test("keeps representative agent destinations outside furniture in both themes", () => {
    const activities: OfficeActivity[] = [
      activity("general", "editing", "edit"),
      activity("firmware-engineer", "executing", "flash"),
      activity("doc-writer", "executing", "write_office"),
      activity("requirements-analyst", "thinking", "plan"),
      activity("hardware-engineer", "standby"),
    ]
    for (const pack of OFFICE_THEME_PACKS) {
      const scene = resolveOfficeScenePositions(pack, {})
      const obstacles = [
        ...resolveOfficeObstacles(pack.obstacles, scene),
        ...resolveOfficeObstacles(pack.navigationBarriers ?? [], scene),
        ...resolveSceneObjectObstacles(pack.sceneObjects ?? [], scene),
      ]
      for (const [index, value] of activities.entries()) {
        const target = agentPosition(value, index, scene)
        const route = planOfficeRoute({ x: 50, y: 92 }, target, { obstacles })
        expect(route.length, `${pack.id}:${value.agentId}`).toBeGreaterThan(0)
        expect(isOfficePointWalkable(route.at(-1)!, obstacles), `${pack.id}:${value.agentId}`).toBe(true)
        assertRouteWalkable({ x: 50, y: 92 }, route, obstacles)
      }
    }
  })

  test("keeps the classic document entrance reachable without entering the east wall cabinets", () => {
    const pack = OFFICE_THEME_PACKS.find((value) => value.id === "classic")!
    const scene = resolveOfficeScenePositions(pack, {})
    const obstacles = [
      ...resolveOfficeObstacles(pack.obstacles, scene),
      ...resolveOfficeObstacles(pack.navigationBarriers ?? [], scene),
      ...resolveSceneObjectObstacles(pack.sceneObjects ?? [], scene),
    ]
    const target = scene["docs-access"]
    expect(target).toEqual({ x: 92, y: 58 })
    expect(isOfficePointWalkable(target, obstacles)).toBe(true)
    const route = planOfficeRoute({ x: 50, y: 92 }, target, { obstacles })
    expect(route.at(-1)).toEqual(target)
    expect(route.every((point) => point.x <= DEFAULT_OFFICE_BOUNDS.maxX - OFFICE_AGENT_RADIUS)).toBe(true)
    assertRouteWalkable({ x: 50, y: 92 }, route, obstacles)
  })

  test("relocates legacy wall and cabinet positions onto the visible floor", () => {
    const pack = OFFICE_THEME_PACKS.find((value) => value.id === "classic")!
    const barriers = resolveOfficeObstacles(pack.navigationBarriers ?? [], pack.anchors)
    const wallPoint = { x: 96, y: 18 }
    expect(isOfficePointWalkable(wallPoint, barriers)).toBe(false)
    const safe = nearestWalkablePoint(wallPoint, barriers)
    expect(safe.x).toBeLessThanOrEqual(DEFAULT_OFFICE_BOUNDS.maxX - OFFICE_AGENT_RADIUS)
    expect(safe.y).toBeGreaterThanOrEqual(35)
  })
})

function activity(agentId: string, state: OfficeActivity["state"], toolName?: string): OfficeActivity {
  return { runId: `${agentId}-${state}`, sessionId: "test", agentId, state, toolName, activity: "test", timestamp: 1 }
}

function assertRouteWalkable(start: OfficePoint, route: OfficePoint[], obstacles: OfficeObstacle[]): void {
  let previous = start
  for (const next of route) {
    const distance = Math.hypot(next.x - previous.x, next.y - previous.y)
    const samples = Math.max(1, Math.ceil(distance / .25))
    for (let index = 0; index <= samples; index++) {
      const progress = index / samples
      const point = { x: previous.x + (next.x - previous.x) * progress, y: previous.y + (next.y - previous.y) * progress }
      expect(isOfficePointWalkable(point, obstacles), `${point.x.toFixed(2)},${point.y.toFixed(2)}`).toBe(true)
    }
    previous = next
  }
}
