import type { OfficePoint } from "./types"
import type { OfficeObstacleSpec } from "./office-navigation"
import {
  CLASSIC_SCENE_OBJECTS,
  resolveSceneInteractionAnchors,
  type OfficeSceneObjectDefinition,
} from "./office-scene-objects"

export interface OfficeThemePack {
  id: string
  name: string
  subtitle: string
  description: string
  tier: "free" | "plus"
  accent: string
  assets: { dark: string; light: string }
  anchors: Record<string, OfficePoint>
  anchorFollowers: Record<string, string>
  obstacles: OfficeObstacleSpec[]
  /** Invisible fixed walls used by navigation but not by foreground repainting. */
  navigationBarriers?: OfficeObstacleSpec[]
  sceneObjects?: OfficeSceneObjectDefinition[]
  includedFurnitureIds: string[]
}

const CLASSIC_ANCHORS: Record<string, OfficePoint> = {
  "desk-project": { x: 12, y: 34 }, "desk-software": { x: 34, y: 34 }, "desk-firmware": { x: 56, y: 34 },
  "seat-project": { x: 12, y: 41 }, "seat-software": { x: 34, y: 41 }, "seat-firmware": { x: 56, y: 41 },
  lab: { x: 82, y: 51 }, schematic: { x: 72, y: 77 }, docs: { x: 91, y: 22 },
  "lab-seat": { x: 82, y: 58 },
  compile: { x: 52, y: 48 }, printer: { x: 91, y: 86 }, coffee: { x: 20, y: 72 },
  whiteboard: { x: 76, y: 22 },
  "lab-access": { x: 69.5, y: 56 }, "schematic-access": { x: 72, y: 84 }, "docs-access": { x: 92, y: 58 },
  "printer-access": { x: 79, y: 74 }, "coffee-access": { x: 34, y: 78 }, "whiteboard-access": { x: 63, y: 45 },
  "meeting-table": { x: 24, y: 61 }, "meeting-access": { x: 34, y: 64 },
  lounge: { x: 18, y: 87 }, "lounge-access": { x: 18, y: 94 },
}

const AURORA_ANCHORS: Record<string, OfficePoint> = {
  "desk-project": { x: 25, y: 24 }, "desk-software": { x: 43, y: 24 }, "desk-firmware": { x: 59, y: 24 },
  "seat-project": { x: 25, y: 37 }, "seat-software": { x: 43, y: 37 }, "seat-firmware": { x: 59, y: 37 },
  lab: { x: 79, y: 31 }, schematic: { x: 78, y: 69 }, docs: { x: 91, y: 50 },
  "lab-seat": { x: 78, y: 42 },
  compile: { x: 58, y: 34 }, printer: { x: 10, y: 46 }, coffee: { x: 18, y: 70 },
  whiteboard: { x: 79, y: 32 },
  "lab-access": { x: 78, y: 45 }, "schematic-access": { x: 78, y: 84 }, "docs-access": { x: 90, y: 57 },
  "printer-access": { x: 18, y: 40 }, "coffee-access": { x: 35, y: 70 }, "whiteboard-access": { x: 79, y: 45 },
  "lounge-access": { x: 18, y: 88 },
  "meeting-access": { x: 48, y: 52 },
}

const ANCHOR_FOLLOWERS: Record<string, string> = {
  "seat-project": "desk-project", "seat-software": "desk-software", "seat-firmware": "desk-firmware",
  "lab-seat": "lab",
  "lab-access": "lab", "schematic-access": "schematic", "docs-access": "docs",
  "printer-access": "printer", "coffee-access": "coffee", "whiteboard-access": "whiteboard",
}

const CLASSIC_OBSTACLES: OfficeObstacleSpec[] = [
  // Movable classic furniture is resolved directly from scene object metadata.
]

const CLASSIC_NAVIGATION_BARRIERS: OfficeObstacleSpec[] = [
  { id: "north-wall", x: 0, y: 0, width: 100, height: 34 },
  { id: "east-wall", x: 95.5, y: 0, width: 4.5, height: 100 },
]

const AURORA_OBSTACLES: OfficeObstacleSpec[] = [
  { id: "desk-project", anchorId: "desk-project", x: -10, y: -11, width: 19, height: 14 },
  { id: "desk-software", anchorId: "desk-software", x: -9, y: -11, width: 18, height: 14 },
  { id: "desk-firmware", anchorId: "desk-firmware", x: -8, y: -11, width: 17, height: 14 },
  { id: "lounge", x: 4, y: 49, width: 28, height: 35 },
  { id: "lab", anchorId: "lab", x: -9, y: -22, width: 27, height: 31 },
  { id: "east-wall-storage", x: 93, y: 43, width: 4, height: 34 },
  { id: "schematic", anchorId: "schematic", x: -9, y: -17, width: 23, height: 28 },
  { id: "printer", anchorId: "printer", x: -6, y: -11, width: 13, height: 20 },
]

export const OFFICE_THEME_PACKS: OfficeThemePack[] = [
  {
    id: "classic", name: "星港工作室", subtitle: "经典永久包", tier: "free", accent: "#5eead4",
    description: "温暖的嵌入式研发基地，包含完整工作区和基础家具。",
    assets: { dark: "/office/modular/office-shell-dark-v1.png", light: "/office/modular/office-shell-light-v1.png" },
    anchors: CLASSIC_ANCHORS,
    anchorFollowers: ANCHOR_FOLLOWERS,
    obstacles: CLASSIC_OBSTACLES,
    navigationBarriers: CLASSIC_NAVIGATION_BARRIERS,
    sceneObjects: CLASSIC_SCENE_OBJECTS,
    includedFurnitureIds: ["mint-plant", "amber-lamp", "blue-beanbag"],
  },
  {
    id: "aurora-lab", name: "极光电路实验室", subtitle: "Plus 主题包", tier: "plus", accent: "#a78bfa",
    description: "极光窗景、霓虹电路和高级科研氛围，含限定家具。",
    assets: { dark: "/office/aurora-lab-dark.png", light: "/office/aurora-lab-light.png" },
    anchors: AURORA_ANCHORS,
    anchorFollowers: ANCHOR_FOLLOWERS,
    obstacles: AURORA_OBSTACLES,
    includedFurnitureIds: ["violet-plant", "aurora-lamp", "mini-server", "circuit-trophy"],
  },
]

export function officeThemePack(id: string): OfficeThemePack {
  return OFFICE_THEME_PACKS.find((pack) => pack.id === id) ?? OFFICE_THEME_PACKS[0]
}

/** Keep invisible access points attached when a user moves a visible zone in layout mode. */
export function resolveOfficeScenePositions(pack: OfficeThemePack, movedAnchors: Record<string, OfficePoint>): Record<string, OfficePoint> {
  const positions: Record<string, OfficePoint> = { ...pack.anchors, ...movedAnchors }
  for (const [followerId, leaderId] of Object.entries(pack.anchorFollowers)) {
    const movedLeader = movedAnchors[leaderId]
    const originalLeader = pack.anchors[leaderId]
    const originalFollower = pack.anchors[followerId]
    if (!movedLeader || !originalLeader || !originalFollower || movedAnchors[followerId]) continue
    positions[followerId] = {
      x: originalFollower.x + movedLeader.x - originalLeader.x,
      y: originalFollower.y + movedLeader.y - originalLeader.y,
    }
  }
  const interactionAnchors = resolveSceneInteractionAnchors(pack.sceneObjects ?? [], positions)
  for (const [id, point] of Object.entries(interactionAnchors)) {
    if (!movedAnchors[id]) positions[id] = point
  }
  return positions
}
