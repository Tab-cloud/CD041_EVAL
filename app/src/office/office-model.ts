import type { OfficeActivity, OfficeAgentState, OfficePoint } from "./types"
import { agentHomePosition, agentWorkPosition } from "./office-workstations"
import { ambientPosition } from "./office-ambient"

export interface OfficePosition { x: number; y: number; zone: string }

const POSITIONS: Record<OfficeAgentState, OfficePosition[]> = {
  queued: [{ x: 49, y: 84, zone: "大厅" }],
  thinking: [{ x: 67, y: 28, zone: "白板区" }],
  reading: [{ x: 72, y: 60, zone: "原理图桌" }, { x: 21, y: 52, zone: "会议资料区" }],
  editing: [{ x: 26, y: 35, zone: "开发工位" }, { x: 48, y: 34, zone: "开发工位" }, { x: 10, y: 40, zone: "开发工位" }],
  executing: [{ x: 79, y: 43, zone: "硬件实验台" }, { x: 86, y: 80, zone: "打印站" }],
  collaborating: [{ x: 23, y: 57, zone: "会议室" }],
  "waiting-human": [{ x: 61, y: 34, zone: "主管门口" }],
  standby: [
    { x: 11, y: 38, zone: "开发工位" }, { x: 27, y: 33, zone: "开发工位" },
    { x: 47, y: 32, zone: "开发工位" }, { x: 70, y: 29, zone: "白板区" },
    { x: 73, y: 60, zone: "原理图桌" }, { x: 86, y: 70, zone: "打印站" },
    { x: 22, y: 61, zone: "资料室" }, { x: 31, y: 70, zone: "咖啡角" },
  ],
  resting: [{ x: 18, y: 80, zone: "休息区" }, { x: 31, y: 79, zone: "咖啡角" }],
  completed: [{ x: 86, y: 80, zone: "成果打印站" }],
  failed: [{ x: 80, y: 45, zone: "故障排查区" }],
}

const STATE_ANCHORS: Partial<Record<OfficeAgentState, Array<{ id: string; dx: number; dy: number; zone: string }>>> = {
  reading: [{ id: "schematic-access", dx: 0, dy: 0, zone: "原理图桌" }, { id: "docs-access", dx: 0, dy: 0, zone: "资料室" }],
  completed: [{ id: "printer-access", dx: 0, dy: 0, zone: "成果打印站" }],
  failed: [{ id: "lab-access", dx: 0, dy: 0, zone: "故障排查区" }],
  collaborating: [{ id: "meeting-access", dx: 0, dy: 0, zone: "会议协作区" }],
}

const LAB_TOOLS = new Set(["flash", "serial_monitor", "swd_debug", "usb_detect", "pin_extract"])
const PRINTER_TOOLS = new Set(["write_office"])
const WHITEBOARD_OFFSETS = [
  { x: -5, y: 0 },
  { x: 0, y: 0 },
  { x: 5, y: 1 },
]

const IDLE_ACTIVITIES = ["喝咖啡补充算力", "给绿植做代码评审", "研究窗外的云", "整理电子元件", "短暂待机充电"]

export function displayActivity(agent: OfficeActivity, now: number): OfficeActivity {
  if (agent.state === "completed" && now - agent.timestamp > 8_000) {
    return { ...agent, state: "standby", activity: "已回到固定工位，等待新任务" }
  }
  if (agent.state === "resting" && now - agent.timestamp > 8_000) {
    const index = hash(agent.runId) % IDLE_ACTIVITIES.length
    return { ...agent, state: "resting", activity: IDLE_ACTIVITIES[index] }
  }
  return agent
}

export function agentPosition(agent: OfficeActivity, ordinal: number, movedStations: Record<string, OfficePoint> = {}): OfficePosition {
  if (agent.state === "standby") return agent.ambientAction
    ? ambientPosition(agent, ordinal, movedStations)
    : agentHomePosition(agent.agentId, ordinal, movedStations)
  if (agent.state === "thinking") {
    const board = movedStations["whiteboard-access"] ?? movedStations.whiteboard ?? POSITIONS.thinking[0]
    const offset = WHITEBOARD_OFFSETS[ordinal % WHITEBOARD_OFFSETS.length]
    return {
      x: Math.max(5, Math.min(94, board.x + offset.x)),
      y: Math.max(12, Math.min(87, board.y + offset.y)),
      zone: "白板规划区",
    }
  }
  if (isWorkstationActivity(agent)) return agentWorkPosition(agent.agentId, ordinal, movedStations)
  if (agent.state === "executing") {
    const destination = PRINTER_TOOLS.has(agent.toolName ?? "")
      ? { id: "printer-access", dx: 0, dy: 0, zone: "打印站" }
      : { id: "lab-access", dx: 0, dy: 0, zone: "硬件实验台" }
    const point = movedStations[destination.id]
    if (point) return { x: point.x + destination.dx, y: point.y + destination.dy, zone: destination.zone }
  }
  const anchors = STATE_ANCHORS[agent.state]
  const anchored = agent.state === "reading" && agent.toolName === "schematic_read"
    ? anchors?.[0]
    : agent.state === "reading" && agent.toolName === "datasheet_read"
      ? anchors?.[1]
      : anchors?.[(hash(agent.runId) + ordinal) % anchors.length]
  const anchorPoint = anchored ? movedStations[anchored.id] : undefined
  if (anchored && anchorPoint) {
    const spread = ((ordinal % 5) - 2) * 6
    return { x: Math.max(5, Math.min(94, anchorPoint.x + anchored.dx + spread)), y: Math.max(12, Math.min(87, anchorPoint.y + anchored.dy)), zone: anchored.zone }
  }
  const choices = POSITIONS[agent.state]
  const base = choices[(hash(agent.runId) + ordinal) % choices.length]
  const offset = ((ordinal % 5) - 2) * 6
  return { ...base, x: Math.max(5, Math.min(94, base.x + offset)), y: Math.max(12, Math.min(72, base.y + (ordinal % 2) * 2)) }
}

/** 思考、编码、编译和普通执行默认在员工自己的电脑工位完成。 */
export function isWorkstationActivity(agent: OfficeActivity): boolean {
  if (agent.state === "editing") return true
  if (agent.state === "executing") {
    const tool = agent.toolName ?? ""
    return !LAB_TOOLS.has(tool) && !PRINTER_TOOLS.has(tool)
  }
  return agent.state === "standby" && agent.ambientAction === "computer"
}

/** Hardware operations use the one physical stool in front of the lab bench. */
export function isLabBenchActivity(agent: OfficeActivity): boolean {
  return agent.state === "executing" && LAB_TOOLS.has(agent.toolName ?? "")
}

export function stateLabel(state: OfficeAgentState): string {
  return ({
    queued: "排队等工位", thinking: "思考中", reading: "查资料", editing: "敲代码",
    executing: "执行任务", collaborating: "协作中", "waiting-human": "等待老板", standby: "待命中",
    resting: "快乐摸鱼", completed: "交付完成", failed: "遇到故障",
  })[state]
}

export function toolState(name: string): OfficeAgentState {
  if (["read", "glob", "grep", "webfetch", "websearch", "skill", "schematic_read", "datasheet_read", "pin_extract"].includes(name)) return "reading"
  if (["write", "edit", "project_init", "lvgl_gen", "chip_add"].includes(name)) return "editing"
  if (name === "task") return "collaborating"
  if (["question", "plan"].includes(name)) return "waiting-human"
  return "executing"
}

export function toolActivity(name: string): string {
  const labels: Record<string, string> = {
    read: "阅读项目文件", glob: "在工程里找资料", grep: "检索代码线索", webfetch: "查阅技术网页",
    websearch: "联网调研", write: "创建新文件", edit: "修改代码", compile: "编译固件",
    flash: "烧录芯片", serial_monitor: "监听串口", swd_debug: "调试硬件", schematic_read: "分析原理图",
    datasheet_read: "阅读数据手册", write_office: "打印技术文档", task: "召集数字同事", plan: "等待方案确认",
    question: "等待用户回答", lvgl_gen: "设计嵌入式界面", project_init: "搭建新工程",
  }
  return labels[name] ?? `执行 ${name}`
}

export function agentColor(id: string, fallback = "#5eead4"): string {
  const colors = ["#5eead4", "#60a5fa", "#f59e0b", "#f472b6", "#a78bfa", "#fb7185", "#34d399", "#facc15"]
  return colors[hash(id) % colors.length] ?? fallback
}

function hash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}
