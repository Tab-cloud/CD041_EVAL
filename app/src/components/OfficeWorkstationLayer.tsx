import type { DragEvent } from "react"
import type { AgentInfo } from "../types"
import type { OfficeActivity, OfficePoint } from "../office/types"
import { OFFICE_WORKSTATIONS, workstationIdForAgent } from "../office/office-workstations"
import { officePersona } from "../office/office-personas"
import { isWorkstationActivity } from "../office/office-model"
import { useI18n, type TranslationKey } from "../i18n"

interface Props {
  agents: AgentInfo[]
  activities: OfficeActivity[]
  editMode: boolean
  positions: Record<string, OfficePoint>
  onMove: (id: string, point: OfficePoint) => void
  onSelectAgent: (agentId: string) => void
}

/** Keep the station plaque in the wall area above the monitor bank. */
export const WORKSTATION_LABEL_OFFSET_Y = 26
export const WORKSTATION_LABEL_MIN_Y = 8

export function OfficeWorkstationLayer({ agents, activities, editMode, positions, onMove, onSelectAgent }: Props) {
  const { t } = useI18n()
  const stationLabelKeys: Record<string, TranslationKey> = {
    "desk-project": "office.station.project",
    "desk-software": "office.station.software",
    "desk-firmware": "office.station.firmware",
  }
  const stationShortLabelKeys: Record<string, TranslationKey> = {
    "desk-project": "office.station.projectShort",
    "desk-software": "office.station.softwareShort",
    "desk-firmware": "office.station.firmwareShort",
  }
  const move = (event: DragEvent<HTMLButtonElement>, id: string) => {
    if (!editMode) return
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!rect) return
    onMove(id, { x: (event.clientX - rect.left) / rect.width * 100, y: (event.clientY - rect.top) / rect.height * 100 })
  }
  return (
    <div className={`office-workstation-layer ${editMode ? "editing" : ""}`}>
      {OFFICE_WORKSTATIONS.map((station) => {
        const point = positions[station.id] ?? station
        const assigned = agents.filter((agent) => workstationIdForAgent(agent.id) === station.id && !["title-gen", "summary-gen"].includes(agent.id))
        const live = assigned
          .map((agent) => activities.filter((activity) => activity.agentId === agent.id && !activity.synthetic).sort((a, b) => b.timestamp - a.timestamp)[0])
          .filter((activity): activity is OfficeActivity => Boolean(activity))
        const active = live.filter((activity) => !["standby", "resting", "completed", "failed"].includes(activity.state))
        const busy = active.some(isWorkstationActivity)
        const away = active.length > 0 && !busy
        const planning = active.some((activity) => activity.state === "thinking")
        const waiting = live.some((activity) => activity.state === "waiting-human")
        const names = assigned.length === 0 ? t("office.station.unassigned") : `${assigned.slice(0, 2).map((agent) => officePersona(agent.id, agent.name).name).join(" · ")}${assigned.length > 2 ? ` +${assigned.length - 2}` : ""}`
        const status = busy ? t("office.station.working") : waiting ? t("office.station.waiting") : planning ? t("office.station.planning") : away ? t("office.station.away") : t("office.station.idle")
        const compactStatus = busy ? t("office.station.workingShort") : waiting ? t("office.station.waitingShort") : planning ? t("office.station.planningShort") : away ? t("office.station.awayShort") : t("office.station.idleShort")
        const assignments = assigned.map((agent) => { const persona = officePersona(agent.id, agent.name); return `${persona.name} (${persona.role})` }).join(" · ") || t("office.station.unassigned")
        const stationLabel = t(stationLabelKeys[station.id])
        const stationShortLabel = t(stationShortLabelKeys[station.id])
        return (
          <button
            key={station.id}
            type="button"
            className={`office-workstation ${busy ? "busy" : waiting ? "waiting" : away ? "away" : "standby"}`}
            style={{ left: `${point.x}%`, top: `${Math.max(WORKSTATION_LABEL_MIN_Y, point.y - WORKSTATION_LABEL_OFFSET_Y)}%` }}
            draggable={editMode}
            onDragEnd={(event) => move(event, station.id)}
            onClick={() => { if (!editMode && assigned[0]) onSelectAgent(assigned[0].id) }}
            title={t("office.station.tooltip", { station: stationLabel, names: assignments, status })}
          >
            <i />
            <span className="office-workstation-copy">
              <span className="office-workstation-heading">
                <strong>{stationShortLabel}</strong>
                <b>{t("office.station.people", { count: assigned.length })}</b>
              </span>
              <small className="office-workstation-state">{compactStatus}</small>
              <small className="office-workstation-details">{names}</small>
            </span>
          </button>
        )
      })}
    </div>
  )
}
