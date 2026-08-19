import type { DragEvent } from "react"
import type { OfficePoint } from "../office/types"
import { INTERACTIVE_OFFICE_ZONES, type OfficeZoneAction } from "../office/office-zones"
import {
  CircuitBoardIcon, CoffeeIcon, FileTextIcon, ZapIcon,
} from "./Icons"

interface Props {
  editMode: boolean
  positions: Record<string, OfficePoint>
  onMove: (id: string, point: OfficePoint) => void
  onAction: (action: OfficeZoneAction) => void
}

const ICONS = {
  lab: ZapIcon,
  schematic: CircuitBoardIcon,
  docs: FileTextIcon,
  coffee: CoffeeIcon,
}

export function OfficeZoneLayer({ editMode, positions, onMove, onAction }: Props) {
  const move = (event: DragEvent<HTMLButtonElement>, id: string) => {
    if (!editMode) return
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!rect) return
    onMove(id, {
      x: (event.clientX - rect.left) / rect.width * 100,
      y: (event.clientY - rect.top) / rect.height * 100,
    })
  }
  return (
    <div className={`office-zone-layer ${editMode ? "editing" : ""}`}>
      {INTERACTIVE_OFFICE_ZONES.map((zone) => {
        const point = positions[zone.id] ?? zone
        const Icon = ICONS[zone.id]
        return (
          <button
            key={zone.id}
            type="button"
            className={`office-zone office-zone-${zone.id}`}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            draggable={editMode}
            onDragEnd={(event) => move(event, zone.id)}
            onClick={() => { if (!editMode) onAction(zone.id) }}
            title={editMode ? `拖动调整${zone.label}位置` : `${zone.label}：${zone.description}`}
          >
            <Icon size={11} /><span>{zone.label}</span>
          </button>
        )
      })}
    </div>
  )
}
