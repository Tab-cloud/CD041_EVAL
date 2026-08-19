import type { OfficePoint } from "./types"

export interface OfficeWorkstation extends OfficePoint {
  id: string
  label: string
  description: string
}

/** 与办公室背景中的三组电脑桌一一对应。 */
export const OFFICE_WORKSTATIONS: OfficeWorkstation[] = [
  { id: "desk-project", label: "通用 / 项目工位", description: "通用协作、项目初始化与自定义 Agent", x: 13, y: 22 },
  { id: "desk-software", label: "软件 / UI / OS 工位", description: "软件开发、界面与实时系统", x: 30, y: 18 },
  { id: "desk-firmware", label: "固件 / 编译 / 测试工位", description: "固件开发、构建与质量验证", x: 49, y: 18 },
]

const STATION_BY_AGENT: Record<string, string> = {
  general: "desk-project",
  "project-initializer": "desk-project",
  "requirements-collector": "desk-project",
  "software-engineer": "desk-software",
  "ui-engineer": "desk-software",
  "ui-dev": "desk-software",
  "os-engineer": "desk-software",
  "firmware-engineer": "desk-firmware",
  "firmware-dev": "desk-firmware",
  "build-agent": "desk-firmware",
  "test-engineer": "desk-firmware",
  "hardware-engineer": "desk-firmware",
  "schematic-analyst": "desk-firmware",
  "component-researcher": "desk-firmware",
  "debug-engineer": "desk-firmware",
  "debug-assistant": "desk-firmware",
  researcher: "desk-project",
  explore: "desk-project",
  "doc-writer": "desk-project",
  "requirements-analyst": "desk-project",
  architect: "desk-project",
  planner: "desk-project",
}

const HOME_BY_AGENT: Record<string, { stationId?: string; anchorId?: string; x: number; y: number; dx?: number; dy?: number; zone: string }> = {
  general: { stationId: "desk-project", x: 10, y: 40, zone: "通用 / 项目工位" },
  "project-initializer": { stationId: "desk-project", x: 16, y: 36, zone: "通用 / 项目工位" },
  "requirements-collector": { stationId: "desk-project", x: 18, y: 42, zone: "通用 / 项目工位" },
  "software-engineer": { stationId: "desk-software", x: 25, y: 35, zone: "软件 / UI / OS 工位" },
  "ui-engineer": { stationId: "desk-software", x: 30, y: 32, zone: "软件 / UI / OS 工位" },
  "ui-dev": { stationId: "desk-software", x: 30, y: 32, zone: "软件 / UI / OS 工位" },
  "os-engineer": { stationId: "desk-software", x: 35, y: 35, zone: "软件 / UI / OS 工位" },
  "firmware-engineer": { stationId: "desk-firmware", x: 44, y: 35, zone: "固件 / 编译 / 测试工位" },
  "firmware-dev": { stationId: "desk-firmware", x: 44, y: 35, zone: "固件 / 编译 / 测试工位" },
  "build-agent": { stationId: "desk-firmware", x: 49, y: 32, zone: "固件 / 编译 / 测试工位" },
  "test-engineer": { stationId: "desk-firmware", x: 54, y: 35, zone: "固件 / 编译 / 测试工位" },
  "hardware-engineer": { anchorId: "schematic-access", x: 64, y: 79, dx: -5, zone: "原理图桌" },
  "schematic-analyst": { anchorId: "schematic-access", x: 69, y: 79, zone: "原理图桌" },
  "component-researcher": { anchorId: "schematic-access", x: 74, y: 79, dx: 5, zone: "原理图桌" },
  researcher: { anchorId: "docs-access", x: 80, y: 29, dx: -3, zone: "资料室" },
  explore: { anchorId: "docs-access", x: 83, y: 29, zone: "资料室" },
  "doc-writer": { anchorId: "docs-access", x: 86, y: 29, dx: 3, zone: "资料室" },
  "requirements-analyst": { anchorId: "whiteboard-access", x: 63, y: 36, dx: -4, zone: "白板规划区" },
  architect: { anchorId: "whiteboard-access", x: 68, y: 36, dx: 1, zone: "白板规划区" },
  planner: { anchorId: "whiteboard-access", x: 72, y: 38, dx: 5, dy: 2, zone: "白板规划区" },
  "debug-engineer": { anchorId: "lab-access", x: 70, y: 58, dx: -3, zone: "硬件实验台" },
  "debug-assistant": { anchorId: "lab-access", x: 76, y: 58, dx: 3, zone: "硬件实验台" },
}

export function workstationIdForAgent(agentId: string): string | null {
  const explicit = STATION_BY_AGENT[agentId]
  if (explicit) return explicit
  if (!agentId || ["title-gen", "summary-gen"].includes(agentId)) return null
  // 新增的自定义 Agent 和未来内置 Agent 也会稳定分配到电脑工位。
  return OFFICE_WORKSTATIONS[stableHash(agentId) % OFFICE_WORKSTATIONS.length].id
}

/** 真实任务的默认工作位置。专业功能区只是临时目的地，不替代员工的电脑工位。 */
export function agentWorkPosition(agentId: string, ordinal = 0, movedStations: Record<string, OfficePoint> = {}): { x: number; y: number; zone: string } {
  const stationId = workstationIdForAgent(agentId) ?? OFFICE_WORKSTATIONS[ordinal % OFFICE_WORKSTATIONS.length].id
  const station = OFFICE_WORKSTATIONS.find((value) => value.id === stationId) ?? OFFICE_WORKSTATIONS[0]
  const point = movedStations[station.id] ?? station
  const slot = stableHash(agentId) % 6
  const column = slot % 3
  const row = Math.floor(slot / 3)
  return {
    x: point.x + (column - 1) * 4.2,
    y: point.y + 13.5 + row * 4.2,
    zone: station.label,
  }
}

export function agentHomePosition(agentId: string, ordinal = 0, movedStations: Record<string, OfficePoint> = {}): { x: number; y: number; zone: string } {
  const explicit = HOME_BY_AGENT[agentId]
  if (explicit) {
    if (explicit.anchorId && movedStations[explicit.anchorId]) {
      const anchor = movedStations[explicit.anchorId]
      return { x: anchor.x + (explicit.dx ?? 0), y: anchor.y + (explicit.dy ?? 0), zone: explicit.zone }
    }
    if (!explicit.stationId || !movedStations[explicit.stationId]) return { x: explicit.x, y: explicit.y, zone: explicit.zone }
    const original = OFFICE_WORKSTATIONS.find((station) => station.id === explicit.stationId)!
    const moved = movedStations[explicit.stationId]
    return { x: explicit.x + moved.x - original.x, y: explicit.y + moved.y - original.y, zone: explicit.zone }
  }

  return agentWorkPosition(agentId, ordinal, movedStations)
}

function stableHash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}
