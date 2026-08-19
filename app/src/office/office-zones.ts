import type { OfficePoint } from "./types"

export type OfficeZoneAction = "lab" | "schematic" | "docs" | "compile" | "printer" | "coffee"
export type InteractiveOfficeZoneAction = Exclude<OfficeZoneAction, "compile" | "printer">

export interface OfficeZoneDefinition extends OfficePoint {
  id: OfficeZoneAction
  label: string
  description: string
}

export const OFFICE_ZONES: OfficeZoneDefinition[] = [
  { id: "lab", label: "实验室", description: "硬件调试与仪器测量", x: 80, y: 39 },
  { id: "schematic", label: "原理图桌", description: "分析电路与引脚连接", x: 71, y: 62 },
  { id: "docs", label: "资料室", description: "整理手册和技术资料", x: 88, y: 20 },
  { id: "compile", label: "编译区", description: "构建、检查和打包工程", x: 47, y: 30 },
  { id: "printer", label: "打印机", description: "生成当前任务进度日报", x: 88, y: 72 },
  { id: "coffee", label: "咖啡机", description: "让员工短暂补充算力", x: 20, y: 72 },
]

/** 编译区和打印机保留为场景/员工动作锚点，不向用户暴露一键 LLM 入口。 */
export const INTERACTIVE_OFFICE_ZONES = OFFICE_ZONES.filter(
  (zone): zone is OfficeZoneDefinition & { id: InteractiveOfficeZoneAction } => zone.id !== "compile" && zone.id !== "printer",
)

export const ZONE_PROMPTS: Partial<Record<OfficeZoneAction, string>> = {
  lab: "请进入实验室诊断模式，结合当前项目检查硬件、串口、烧录或调试问题，并给出下一步操作。",
  schematic: "请分析当前项目中的原理图、电路连接和关键引脚，指出风险与需要核对的地方。",
  docs: "请整理当前项目的技术资料、数据手册和已有文档，输出资料缺口与建议阅读顺序。",
}
