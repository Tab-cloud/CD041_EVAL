import type { OfficeInteractionPhase } from "./AgentOfficeAvatar"
import { OFFICE_WORKSTATIONS } from "../office/office-workstations"
import { officeSeatPoint, resolveOfficeSeatObstacles, type OfficeSeatAssignment } from "../office/office-seats"
import type { OfficePoint } from "../office/types"
import { officeChairPose, officeChairZIndex } from "../office/office-layering"

interface Props {
  assignments: OfficeSeatAssignment[]
  phases: Record<string, OfficeInteractionPhase>
  positions: Record<string, OfficePoint>
  editMode: boolean
}

export function OfficeChairLayer({ assignments, phases, positions, editMode }: Props) {
  const occupantByStation = new Map(assignments.map((assignment) => [assignment.stationId, assignment]))
  const labPoint = positions["lab-seat"]
  const labOccupant = assignments.find((assignment) => assignment.kind === "lab-stool")
  return (
    <div className="office-chair-layer" aria-hidden="true">
      {editMode && resolveOfficeSeatObstacles(positions).map((obstacle) => (
        <span
          key={obstacle.id}
          className="office-seat-footprint"
          style={{ left: `${obstacle.x}%`, top: `${obstacle.y}%`, width: `${obstacle.width}%`, height: `${obstacle.height}%` }}
        />
      ))}
      {OFFICE_WORKSTATIONS.map((station) => {
        const point = officeSeatPoint(station.id, positions)
        const occupant = occupantByStation.get(station.id)
        const phase = occupant ? phases[occupant.runId] : undefined
        const pose = officeChairPose(phase)
        return (
          <span
            key={station.id}
            className={`office-workstation-chair chair-${pose} ${occupant ? "occupied" : "empty"}`}
            style={{
              left: `${point.x}%`,
              top: `${point.y}%`,
              // Once seated, the chair back is physically between the viewer
              // and the employee's torso. During entry/exit it stays behind.
              zIndex: officeChairZIndex(point.y, phase === "seated"),
            }}
          />
        )
      })}
      {labPoint && (
        <span
          className={`office-lab-stool ${labOccupant ? "occupied" : "empty"}`}
          style={{ left: `${labPoint.x}%`, top: `${labPoint.y}%`, zIndex: officeChairZIndex(labPoint.y, false) - 8 }}
        />
      )}
    </div>
  )
}
