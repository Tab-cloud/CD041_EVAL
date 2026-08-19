import { isLabBenchActivity, isWorkstationActivity } from "./office-model"
import { OFFICE_WORKSTATIONS, workstationIdForAgent } from "./office-workstations"
import type { OfficeObstacle } from "./office-navigation"
import type { OfficeActivity, OfficePoint } from "./types"

export interface OfficeSeatAssignment extends OfficePoint {
  runId: string
  seatId: string
  stationId: string
  zone: string
  kind: "workstation" | "lab-stool"
}

// Every workstation shape has its own physical chair anchor. The project desk
// is L-shaped and much deeper than the two straight desks, so a shared offset
// would place its chair and employee on the tabletop.
const WORKSTATION_SEAT_ANCHORS: Record<string, string> = {
  "desk-project": "seat-project",
  "desk-software": "seat-software",
  "desk-firmware": "seat-firmware",
}

// Compatibility fallback for custom/legacy packs that do not declare seats.
const SEAT_OFFSET = { x: 0, y: 12 }
const CHAIR_FOOTPRINT = { dx: -3.4, dy: -8, width: 6.8, height: 9 }
const LAB_STOOL_FOOTPRINT = { dx: -2.6, dy: -5, width: 5.2, height: 6 }

export function officeSeatObstacleId(seatId: string): string {
  return `seat:${seatId}`
}

/** Empty chairs and the laboratory stool are physical scene objects too. */
export function resolveOfficeSeatObstacles(anchors: Record<string, OfficePoint>): OfficeObstacle[] {
  const chairs = OFFICE_WORKSTATIONS.map((station) => {
    const point = officeSeatPoint(station.id, anchors)
    return {
      id: officeSeatObstacleId(`${station.id}:chair`),
      x: point.x + CHAIR_FOOTPRINT.dx,
      y: point.y + CHAIR_FOOTPRINT.dy,
      width: CHAIR_FOOTPRINT.width,
      height: CHAIR_FOOTPRINT.height,
    }
  })
  const labSeat = anchors["lab-seat"]
  if (!labSeat) return chairs
  return [...chairs, {
    id: officeSeatObstacleId("lab:stool"),
    x: labSeat.x + LAB_STOOL_FOOTPRINT.dx,
    y: labSeat.y + LAB_STOOL_FOOTPRINT.dy,
    width: LAB_STOOL_FOOTPRINT.width,
    height: LAB_STOOL_FOOTPRINT.height,
  }]
}

/** The assigned employee may enter its own seat; every other seat stays solid. */
export function navigationObstaclesForSeat(obstacles: OfficeObstacle[], seat: OfficeSeatAssignment | undefined): OfficeObstacle[] {
  if (!seat) return obstacles
  const ownSeatId = officeSeatObstacleId(seat.seatId)
  return obstacles.filter((obstacle) => obstacle.id !== ownSeatId)
}

export function officeSeatPoint(stationId: string, anchors: Record<string, OfficePoint>): OfficePoint {
  const station = OFFICE_WORKSTATIONS.find((value) => value.id === stationId) ?? OFFICE_WORKSTATIONS[0]
  const seatAnchor = anchors[WORKSTATION_SEAT_ANCHORS[station.id]]
  if (seatAnchor) return seatAnchor
  const anchor = anchors[station.id] ?? station
  return { x: anchor.x + SEAT_OFFSET.x, y: anchor.y + SEAT_OFFSET.y }
}

/** Reserve one visible chair per working employee. A chair can never be shared. */
export function assignOfficeSeats(activities: OfficeActivity[], anchors: Record<string, OfficePoint>): Record<string, OfficeSeatAssignment> {
  const assignments: Record<string, OfficeSeatAssignment> = {}
  const occupied = new Set<string>()
  // Real work must reserve physical chairs before standby employees that are
  // merely using a computer as an ambient office-life action.
  const candidates = activities
    .map((activity, index) => ({ activity, index }))
    .filter(({ activity }) => isWorkstationActivity(activity))
    .sort((left, right) => workstationPriority(left.activity) - workstationPriority(right.activity) || left.index - right.index)

  for (const { activity } of candidates) {
    const preferred = workstationIdForAgent(activity.agentId) ?? OFFICE_WORKSTATIONS[0].id
    const stationOrder = [preferred, ...OFFICE_WORKSTATIONS.map((station) => station.id).filter((id) => id !== preferred)]
    let reservation: { stationId: string } | null = null

    for (const stationId of stationOrder) {
      if (!occupied.has(stationId)) { reservation = { stationId }; break }
    }
    if (!reservation) continue

    const station = OFFICE_WORKSTATIONS.find((value) => value.id === reservation.stationId) ?? OFFICE_WORKSTATIONS[0]
    const point = officeSeatPoint(station.id, anchors)
    const seatId = `${reservation.stationId}:chair`
    occupied.add(reservation.stationId)
    assignments[activity.runId] = {
      runId: activity.runId,
      seatId,
      stationId: reservation.stationId,
      zone: station.label,
      kind: "workstation",
      x: point.x,
      y: point.y,
    }
  }

  return assignments
}

function workstationPriority(activity: OfficeActivity): number {
  return activity.state === "standby" ? 1 : 0
}

/** The lab contains one real stool, so at most one active hardware worker can sit there. */
export function assignOfficeLabSeat(activities: OfficeActivity[], anchors: Record<string, OfficePoint>): Record<string, OfficeSeatAssignment> {
  const activity = activities.find(isLabBenchActivity)
  const point = anchors["lab-seat"]
  if (!activity || !point) return {}
  return {
    [activity.runId]: {
      runId: activity.runId,
      seatId: "lab:stool",
      stationId: "lab",
      zone: "焊接台圆凳",
      kind: "lab-stool",
      x: point.x,
      y: point.y,
    },
  }
}
