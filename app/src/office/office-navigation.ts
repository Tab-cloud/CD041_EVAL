import type { OfficeFurniturePlacement, OfficePoint } from "./types"
import { officeFurnitureItem } from "./office-furniture"

export interface OfficeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface OfficeObstacle extends OfficeRect {
  id: string
}

export interface OfficeObstacleSpec extends OfficeRect {
  id: string
  anchorId?: string
}

export interface OfficeNavigationBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface OfficeRouteOptions {
  obstacles?: OfficeObstacle[]
  bounds?: OfficeNavigationBounds
  /** Radius of the employee's floor capsule in office percentage units. */
  agentRadius?: number
}

const GRID_STEP = 2
export const OFFICE_AGENT_RADIUS = 1.35
export const OFFICE_WALK_SPEED = 8.5
// Bounds describe the visible floor, not the full illustration canvas. Keeping
// navigation below the wall line and away from the east cabinets prevents a
// character's feet from being placed on vertical architecture.
export const DEFAULT_OFFICE_BOUNDS: OfficeNavigationBounds = { minX: 4, maxX: 94, minY: 30, maxY: 92 }

/** Resolve obstacle rectangles after the user has moved a workstation or functional zone. */
export function resolveOfficeObstacles(specs: OfficeObstacleSpec[], anchors: Record<string, OfficePoint>): OfficeObstacle[] {
  return specs.map((spec) => {
    const anchor = spec.anchorId ? anchors[spec.anchorId] : undefined
    return {
      id: spec.id,
      x: spec.x + (anchor?.x ?? 0),
      y: spec.y + (anchor?.y ?? 0),
      width: spec.width,
      height: spec.height,
    }
  })
}

/** Convert user-placed store furniture into live navigation obstacles. Rugs remain walkable. */
export function resolvePlacedFurnitureObstacles(placements: OfficeFurniturePlacement[]): OfficeObstacle[] {
  return placements.flatMap((placement) => {
    const item = officeFurnitureItem(placement.itemId)
    if (!item || item.kind === "rug") return []
    const clearance = Math.max(2.2, item.radius * .72)
    return [{
      id: `furniture:${placement.instanceId}`,
      x: placement.x - clearance,
      y: placement.y - clearance,
      width: clearance * 2,
      height: clearance * 2,
    }]
  })
}

/** A* pathfinding on the office walkable floor. Furniture rectangles are never crossed. */
export function planOfficeRoute(from: OfficePoint, to: OfficePoint, options: OfficeRouteOptions = {}): OfficePoint[] {
  const bounds = options.bounds ?? DEFAULT_OFFICE_BOUNDS
  const obstacles = options.obstacles ?? []
  const radius = options.agentRadius ?? OFFICE_AGENT_RADIUS
  const start = nearestWalkablePoint(from, obstacles, bounds, radius)
  const target = nearestWalkablePoint(clampPoint(to, bounds), obstacles, bounds, radius)
  const gridStart = nearestWalkablePoint(fromGridPoint(toGridPoint(start, bounds), bounds), obstacles, bounds, radius)
  const gridTarget = nearestWalkablePoint(fromGridPoint(toGridPoint(target, bounds), bounds), obstacles, bounds, radius)
  const startNode = toGridPoint(gridStart, bounds)
  const targetNode = toGridPoint(gridTarget, bounds)
  const route = findGridRoute(startNode, targetNode, obstacles, bounds, radius)
  if (route.length === 0) return []

  const points = route.map((node) => fromGridPoint(node, bounds))
  const simplified = simplifyOrthogonalRoute(points)
  if (!pointsEqual(simplified[simplified.length - 1], target) && isSafeSegment(simplified[simplified.length - 1] ?? gridStart, target, obstacles, bounds, radius)) simplified.push(target)
  return simplified
}

export function isOfficePointWalkable(point: OfficePoint, obstacles: OfficeObstacle[], bounds: OfficeNavigationBounds = DEFAULT_OFFICE_BOUNDS, radius = 0): boolean {
  if (point.x < bounds.minX + radius || point.x > bounds.maxX - radius || point.y < bounds.minY + radius || point.y > bounds.maxY - radius) return false
  return !obstacles.some((obstacle) => point.x >= obstacle.x - radius && point.x <= obstacle.x + obstacle.width + radius && point.y >= obstacle.y - radius && point.y <= obstacle.y + obstacle.height + radius)
}

export function nearestWalkablePoint(point: OfficePoint, obstacles: OfficeObstacle[], bounds: OfficeNavigationBounds = DEFAULT_OFFICE_BOUNDS, radius = OFFICE_AGENT_RADIUS): OfficePoint {
  const clamped = clampPoint(point, bounds)
  if (isOfficePointWalkable(clamped, obstacles, bounds, radius)) return clamped
  for (let searchRadius = GRID_STEP; searchRadius <= 36; searchRadius += GRID_STEP) {
    const candidates: OfficePoint[] = []
    for (let offset = -searchRadius; offset <= searchRadius; offset += GRID_STEP) {
      candidates.push(
        { x: clamped.x + offset, y: clamped.y - searchRadius },
        { x: clamped.x + offset, y: clamped.y + searchRadius },
        { x: clamped.x - searchRadius, y: clamped.y + offset },
        { x: clamped.x + searchRadius, y: clamped.y + offset },
      )
    }
    const walkable = candidates
      .map((candidate) => clampPoint(candidate, bounds))
      .filter((candidate) => isOfficePointWalkable(candidate, obstacles, bounds, radius))
      .sort((a, b) => distance(a, clamped) - distance(b, clamped))[0]
    if (walkable) return walkable
  }
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
}

export function officeSpawnPoint(agentId: string, bounds: OfficeNavigationBounds = DEFAULT_OFFICE_BOUNDS): OfficePoint {
  const offset = stableHash(agentId) % 7 - 3
  return { x: (bounds.minX + bounds.maxX) / 2 + offset * 1.5, y: bounds.maxY - 1 }
}

export function routeDirection(from: OfficePoint, to: OfficePoint): "left" | "right" | "front" | "back" {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right"
  return dy < 0 ? "back" : "front"
}

interface GridPoint { x: number; y: number }

function findGridRoute(start: GridPoint, target: GridPoint, obstacles: OfficeObstacle[], bounds: OfficeNavigationBounds, radius: number): GridPoint[] {
  const open = new Set<string>([nodeKey(start)])
  const cameFrom = new Map<string, GridPoint>()
  const gScore = new Map<string, number>([[nodeKey(start), 0]])
  const fScore = new Map<string, number>([[nodeKey(start), gridDistance(start, target)]])

  while (open.size > 0) {
    const currentKey = [...open].sort((a, b) => (fScore.get(a) ?? Infinity) - (fScore.get(b) ?? Infinity))[0]
    const current = parseNodeKey(currentKey)
    if (current.x === target.x && current.y === target.y) return reconstructRoute(cameFrom, current)
    open.delete(currentKey)

    for (const neighbor of gridNeighbors(current)) {
      const point = fromGridPoint(neighbor, bounds)
      if (!isOfficePointWalkable(point, obstacles, bounds, radius)) continue
      const neighborKey = nodeKey(neighbor)
      const tentative = (gScore.get(currentKey) ?? Infinity) + 1
      if (tentative >= (gScore.get(neighborKey) ?? Infinity)) continue
      cameFrom.set(neighborKey, current)
      gScore.set(neighborKey, tentative)
      fScore.set(neighborKey, tentative + gridDistance(neighbor, target))
      open.add(neighborKey)
    }
  }
  return []
}

function reconstructRoute(cameFrom: Map<string, GridPoint>, current: GridPoint): GridPoint[] {
  const route = [current]
  let cursor = current
  while (cameFrom.has(nodeKey(cursor))) {
    cursor = cameFrom.get(nodeKey(cursor))!
    route.unshift(cursor)
  }
  return route.slice(1)
}

function simplifyOrthogonalRoute(points: OfficePoint[]): OfficePoint[] {
  if (points.length < 3) return points
  const result = [points[0]]
  for (let index = 1; index < points.length - 1; index++) {
    const previous = result[result.length - 1]
    const current = points[index]
    const next = points[index + 1]
    const sameVertical = Math.abs(previous.x - current.x) < 0.1 && Math.abs(current.x - next.x) < 0.1
    const sameHorizontal = Math.abs(previous.y - current.y) < 0.1 && Math.abs(current.y - next.y) < 0.1
    if (!sameVertical && !sameHorizontal) result.push(current)
  }
  result.push(points[points.length - 1])
  return result
}

function toGridPoint(point: OfficePoint, bounds: OfficeNavigationBounds): GridPoint {
  return {
    x: Math.round((point.x - bounds.minX) / GRID_STEP),
    y: Math.round((point.y - bounds.minY) / GRID_STEP),
  }
}
function fromGridPoint(point: GridPoint, bounds: OfficeNavigationBounds): OfficePoint {
  return { x: bounds.minX + point.x * GRID_STEP, y: bounds.minY + point.y * GRID_STEP }
}
function gridNeighbors(point: GridPoint): GridPoint[] {
  return [
    { x: point.x - 1, y: point.y }, { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y - 1 }, { x: point.x, y: point.y + 1 },
  ]
}
function gridDistance(a: GridPoint, b: GridPoint): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) }
function nodeKey(point: GridPoint): string { return `${point.x}:${point.y}` }
function parseNodeKey(key: string): GridPoint { const [x, y] = key.split(":").map(Number); return { x, y } }
function clampPoint(point: OfficePoint, bounds: OfficeNavigationBounds): OfficePoint {
  return { x: Math.max(bounds.minX, Math.min(bounds.maxX, point.x)), y: Math.max(bounds.minY, Math.min(bounds.maxY, point.y)) }
}
function distance(a: OfficePoint, b: OfficePoint): number { return Math.hypot(a.x - b.x, a.y - b.y) }
function pointsEqual(a: OfficePoint | undefined, b: OfficePoint): boolean { return Boolean(a && distance(a, b) < 0.1) }
function isSafeSegment(from: OfficePoint, to: OfficePoint, obstacles: OfficeObstacle[], bounds: OfficeNavigationBounds, radius: number): boolean {
  const length = distance(from, to)
  const steps = Math.max(1, Math.ceil(length / .25))
  for (let index = 0; index <= steps; index++) {
    const progress = index / steps
    if (!isOfficePointWalkable({ x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress }, obstacles, bounds, radius)) return false
  }
  return true
}
function stableHash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}
