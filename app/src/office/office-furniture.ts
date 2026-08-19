import type { OfficeFurniturePlacement, OfficePoint } from "./types"

export type OfficeFurnitureKind = "plant" | "lamp" | "seat" | "server" | "trophy" | "table" | "rug" | "decor"

export interface OfficeFurnitureItem {
  id: string
  name: string
  description: string
  kind: OfficeFurnitureKind
  radius: number
  premium?: boolean
}

export const OFFICE_FURNITURE: OfficeFurnitureItem[] = [
  { id: "mint-plant", name: "薄荷盆栽", description: "让工位附近多一点生命力", kind: "plant", radius: 5 },
  { id: "amber-lamp", name: "琥珀落地灯", description: "暖色小范围氛围光", kind: "lamp", radius: 4 },
  { id: "blue-beanbag", name: "云朵懒人椅", description: "待命员工喜欢的充电座位", kind: "seat", radius: 6 },
  { id: "violet-plant", name: "极光蕨", description: "带紫色微光的限定绿植", kind: "plant", radius: 5, premium: true },
  { id: "aurora-lamp", name: "星轨灯", description: "投射青紫渐变光晕", kind: "lamp", radius: 4, premium: true },
  { id: "mini-server", name: "迷你算力塔", description: "会呼吸闪烁的本地算力节点", kind: "server", radius: 6, premium: true },
  { id: "circuit-trophy", name: "电路奖杯", description: "纪念一次漂亮的版本交付", kind: "trophy", radius: 4, premium: true },
  { id: "sunset-sofa", name: "落日双人沙发", description: "适合两位待命员工讨论项目", kind: "seat", radius: 8, premium: true },
  { id: "cat-cushion", name: "猫咪抱枕", description: "会让休息角更柔软的小摆件", kind: "decor", radius: 3, premium: true },
  { id: "tea-table", name: "暖光茶几", description: "放茶杯与项目便签的小桌", kind: "table", radius: 5, premium: true },
  { id: "pixel-aquarium", name: "像素水族箱", description: "带动态蓝光的减压装饰", kind: "decor", radius: 6, premium: true },
  { id: "blueprint-rug", name: "蓝图地毯", description: "印有电路线路的实验室地毯", kind: "rug", radius: 7, premium: true },
  { id: "debug-duck", name: "调试小黄鸭", description: "完成首次交付后获得的桌面伙伴", kind: "decor", radius: 3 },
  { id: "commit-board", name: "提交里程碑板", description: "记录团队连续交付的成长看板", kind: "decor", radius: 5 },
  { id: "release-trophy", name: "版本发布杯", description: "为稳定完成多个项目任务而颁发", kind: "trophy", radius: 4 },
]

export function officeFurnitureItem(id: string): OfficeFurnitureItem | undefined {
  return OFFICE_FURNITURE.find((item) => item.id === id)
}

export function canPlaceFurniture(point: OfficePoint, placements: OfficeFurniturePlacement[], itemId: string, ignoredId?: string): boolean {
  if (point.x < 7 || point.x > 93 || point.y < 16 || point.y > 87) return false
  const radius = officeFurnitureItem(itemId)?.radius ?? 5
  return placements.every((placement) => {
    if (placement.instanceId === ignoredId) return true
    const otherRadius = officeFurnitureItem(placement.itemId)?.radius ?? 5
    return Math.hypot(point.x - placement.x, point.y - placement.y) >= radius + otherRadius
  })
}

export function findFurnitureSpace(placements: OfficeFurniturePlacement[], itemId: string): OfficePoint | null {
  const candidates = [
    { x: 46, y: 72 }, { x: 54, y: 72 }, { x: 38, y: 68 }, { x: 61, y: 59 },
    { x: 29, y: 76 }, { x: 68, y: 76 }, { x: 11, y: 60 }, { x: 88, y: 60 },
  ]
  return candidates.find((point) => canPlaceFurniture(point, placements, itemId)) ?? null
}
