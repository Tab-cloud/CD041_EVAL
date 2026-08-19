import { Fragment, useEffect, useState, type DragEvent } from "react"
import type { OfficeSceneObjectDefinition } from "../office/office-scene-objects"
import { officeSceneFrontZIndex } from "../office/office-layering"
import type { OfficePoint } from "../office/types"

interface Props {
  objects: OfficeSceneObjectDefinition[]
  positions: Record<string, OfficePoint>
  editMode: boolean
  onMove: (id: string, point: OfficePoint) => void
}

export function OfficeSceneObjectLayer({ objects, positions, editMode, onMove }: Props) {
  const reducedMotion = usePrefersReducedMotion()

  const move = (event: DragEvent<HTMLButtonElement>, object: OfficeSceneObjectDefinition) => {
    if (!editMode || !object.movable) return
    const world = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!world) return
    onMove(object.id, {
      x: clamp((event.clientX - world.left) / world.width * 100, 5, 95),
      y: clamp((event.clientY - world.top) / world.height * 100, 14, 91),
    })
  }

  return (
    <div className={`office-scene-object-layer ${editMode ? "editing" : ""}`}>
      {objects.map((object) => {
        const point = positions[object.id]
        if (!point) return null
        const asset = object.asset
        const lightAsset = resolveMotionAsset(asset?.light, asset?.ambientMotion, asset?.reducedMotionFallback, editMode || reducedMotion)
        const baseZ = object.kind === "rug" ? 3 : object.kind === "wall" ? 5 : Math.round(point.y) + 10
        const style = {
          left: `${point.x}%`, top: `${point.y}%`, width: `${object.width}%`, zIndex: baseZ,
        }
        return (
          <Fragment key={object.id}>
            {editMode && object.footprint && (
              <span
                className="office-scene-object-footprint"
                style={{
                  left: `${point.x + object.footprint.dx}%`,
                  top: `${point.y + object.footprint.dy}%`,
                  width: `${object.footprint.width}%`,
                  height: `${object.footprint.height}%`,
                }}
                aria-hidden="true"
              />
            )}
            {editMode && (object.interactionSlots ?? []).map((slot) => (
              <span
                key={slot.id}
                className={`office-scene-interaction-slot slot-${slot.kind}`}
                style={{ left: `${point.x + slot.x}%`, top: `${point.y + slot.y}%` }}
                title={slot.id}
                aria-hidden="true"
              />
            ))}
            <button
              type="button"
              className={`office-scene-object object-${object.kind} ${asset?.dark ? "has-dark-asset" : ""} ${object.cssVariant ? `object-${object.cssVariant}` : ""}`}
              style={style}
              draggable={editMode && object.movable}
              onDragEnd={(event) => move(event, object)}
              title={editMode ? `拖动${object.label}` : object.label}
              aria-label={object.label}
            >
              {asset ? <SceneObjectImages light={lightAsset} dark={asset.dark} /> : <span className="office-scene-object-shape" />}
            </button>
            {asset && object.frontOcclusionStart !== undefined && (
              <span
                className={`office-scene-object-front ${asset.dark ? "has-dark-asset" : ""}`}
                style={{
                  ...style,
                  zIndex: officeSceneFrontZIndex(point.y),
                  clipPath: `inset(${object.frontOcclusionStart}% 0 0 0)`,
                }}
                aria-hidden="true"
              >
                <SceneObjectImages light={lightAsset} dark={asset.dark} />
              </span>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

function SceneObjectImages({ light, dark }: { light: string; dark?: string }) {
  return (
    <>
      <img className="office-object-image object-image-light" src={light} alt="" draggable={false} />
      {dark && <img className="office-object-image object-image-dark" src={dark} alt="" draggable={false} />}
    </>
  )
}

function resolveMotionAsset(
  staticAsset: string | undefined,
  motionAsset: string | undefined,
  fallback: string | undefined,
  paused: boolean,
): string {
  if (!staticAsset) return ""
  if (paused) return fallback ?? staticAsset
  return motionAsset ?? staticAsset
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  return reduced
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
