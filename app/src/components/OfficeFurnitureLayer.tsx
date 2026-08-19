import type { DragEvent } from "react"
import { canPlaceFurniture, officeFurnitureItem } from "../office/office-furniture"
import type { OfficeFurniturePlacement, OfficePoint } from "../office/types"

interface Props {
  placements: OfficeFurniturePlacement[]
  editMode: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onMove: (id: string, point: OfficePoint) => void
  onInvalid: () => void
}

export function OfficeFurnitureLayer({ placements, editMode, selectedId, onSelect, onMove, onInvalid }: Props) {
  const move = (event: DragEvent<HTMLButtonElement>, placement: OfficeFurniturePlacement) => {
    if (!editMode) return
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!rect) return
    const point = { x: (event.clientX - rect.left) / rect.width * 100, y: (event.clientY - rect.top) / rect.height * 100 }
    if (!canPlaceFurniture(point, placements, placement.itemId, placement.instanceId)) { onInvalid(); return }
    onMove(placement.instanceId, point)
  }
  return <div className="office-furniture-layer">
    {placements.map((placement) => {
      const item = officeFurnitureItem(placement.itemId)
      if (!item) return null
      return <button key={placement.instanceId} type="button"
        className={`office-furniture furniture-${item.kind} furniture-${item.id} ${selectedId === placement.instanceId ? "selected" : ""}`}
        style={{ left: `${placement.x}%`, top: `${placement.y}%`, zIndex: Math.round(placement.y) + 8, transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)` }}
        draggable={editMode} onDragEnd={(event) => move(event, placement)}
        onClick={() => { if (editMode) onSelect(placement.instanceId) }}
        title={editMode ? `拖动${item.name}` : item.description} aria-label={item.name}>
        <span className="furniture-shape" aria-hidden="true"><i /><b /><em /></span>
      </button>
    })}
  </div>
}
