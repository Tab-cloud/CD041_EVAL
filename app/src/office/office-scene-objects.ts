import type { OfficeObstacle } from "./office-navigation"
import type { OfficePoint } from "./types"

export type OfficeSceneObjectKind =
  | "workstation"
  | "workbench"
  | "meeting-table"
  | "seat"
  | "printer"
  | "wall"
  | "rug"

export interface OfficeSceneObjectAsset {
  light: string
  dark?: string
  /** Optional ambient loop. GIF/WebP is allowed only for non-physical decoration. */
  ambientMotion?: string
  reducedMotionFallback?: string
}

export interface OfficeSceneFootprint {
  dx: number
  dy: number
  width: number
  height: number
}

export interface OfficeSceneInteractionSlot extends OfficePoint {
  id: string
  kind: "seat" | "work" | "approach"
}

export interface OfficeSceneObjectDefinition {
  id: string
  label: string
  kind: OfficeSceneObjectKind
  asset?: OfficeSceneObjectAsset
  /** Render width as a percentage of the 16:9 office world. */
  width: number
  footprint?: OfficeSceneFootprint
  interactionSlots?: OfficeSceneInteractionSlot[]
  /** Percentage of the sprite height repainted in front of nearby characters. */
  frontOcclusionStart?: number
  movable?: boolean
  cssVariant?: "whiteboard" | "rug"
}

const MODULAR_ASSET_ROOT = "/office/modular"

/**
 * Classic office v3. Every visible object is a scene node. Its image, physical
 * footprint, occlusion edge and interaction slots share the same anchor.
 */
export const CLASSIC_SCENE_OBJECTS: OfficeSceneObjectDefinition[] = [
  workstation("desk-project", "项目工位", 20),
  workstation("desk-software", "软件工位", 20),
  workstation("desk-firmware", "固件工位", 20),
  {
    id: "whiteboard", label: "规划白板", kind: "wall", width: 18,
    cssVariant: "whiteboard", movable: true,
    interactionSlots: [{ id: "whiteboard-access", kind: "approach", x: -13, y: 23 }],
  },
  {
    id: "meeting-table", label: "项目会议桌", kind: "meeting-table", width: 19,
    asset: staticAsset("meeting-table-trimmed-v1.png"), movable: true,
    footprint: { dx: -9, dy: -21, width: 18, height: 22 }, frontOcclusionStart: 48,
    interactionSlots: [
      { id: "meeting-north", kind: "seat", x: 0, y: -6 },
      { id: "meeting-south", kind: "seat", x: 0, y: 6 },
      { id: "meeting-access", kind: "approach", x: 11, y: 3 },
    ],
  },
  {
    id: "lounge", label: "三人沙发", kind: "seat", width: 20,
    asset: staticAsset("lounge-sofa-trimmed-v1.png"), movable: true,
    footprint: { dx: -9.5, dy: -22, width: 19, height: 23 }, frontOcclusionStart: 55,
    interactionSlots: [
      { id: "lounge-seat-left", kind: "seat", x: -5, y: -1 },
      { id: "lounge-seat-center", kind: "seat", x: 0, y: -1 },
      { id: "lounge-seat-right", kind: "seat", x: 5, y: -1 },
      { id: "lounge-access", kind: "approach", x: 0, y: 7 },
    ],
  },
  {
    id: "lab", label: "电子实验台", kind: "workbench", width: 22,
    asset: staticAsset("lab-bench-trimmed-v1.png"), movable: true,
    footprint: { dx: -10.5, dy: -27, width: 21, height: 28 }, frontOcclusionStart: 55,
    interactionSlots: [
      { id: "lab-seat", kind: "seat", x: 0, y: 7 },
      { id: "lab-access", kind: "approach", x: -12.5, y: 5 },
    ],
  },
  {
    id: "schematic", label: "原理图桌", kind: "workbench", width: 21,
    asset: staticAsset("schematic-workbench-trimmed-v1.png"), movable: true,
    footprint: { dx: -10, dy: -28, width: 20, height: 29 }, frontOcclusionStart: 54,
    interactionSlots: [{ id: "schematic-access", kind: "approach", x: 0, y: 7 }],
  },
  {
    id: "printer", label: "打印复印区", kind: "printer", width: 10,
    asset: staticAsset("printer-station-trimmed-v1.png"), movable: true,
    footprint: { dx: -4.8, dy: -17, width: 9.6, height: 18 }, frontOcclusionStart: 58,
    interactionSlots: [{ id: "printer-access", kind: "approach", x: -7, y: 2 }],
  },
]

export function resolveSceneObjectObstacles(
  objects: OfficeSceneObjectDefinition[],
  anchors: Record<string, OfficePoint>,
): OfficeObstacle[] {
  return objects.flatMap((object) => {
    const anchor = anchors[object.id]
    const footprint = object.footprint
    if (!anchor || !footprint) return []
    return [{
      id: `scene:${object.id}`,
      x: anchor.x + footprint.dx,
      y: anchor.y + footprint.dy,
      width: footprint.width,
      height: footprint.height,
    }]
  })
}

export function resolveSceneInteractionAnchors(
  objects: OfficeSceneObjectDefinition[],
  anchors: Record<string, OfficePoint>,
): Record<string, OfficePoint> {
  const result: Record<string, OfficePoint> = {}
  for (const object of objects) {
    const anchor = anchors[object.id]
    if (!anchor) continue
    for (const slot of object.interactionSlots ?? []) {
      result[slot.id] = { x: anchor.x + slot.x, y: anchor.y + slot.y }
    }
  }
  return result
}

function workstation(id: string, label: string, width: number): OfficeSceneObjectDefinition {
  return {
    id, label, kind: "workstation", width,
    asset: staticAsset("workstation-trimmed-v1.png"), movable: true,
    footprint: { dx: -9.5, dy: -27, width: 19, height: 27 }, frontOcclusionStart: 56,
  }
}

function staticAsset(filename: string): OfficeSceneObjectAsset {
  return { light: `${MODULAR_ASSET_ROOT}/${filename}` }
}
