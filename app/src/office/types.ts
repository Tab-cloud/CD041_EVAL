export type OfficeAgentState =
  | "queued" | "thinking" | "reading" | "editing" | "executing"
  | "collaborating" | "waiting-human" | "standby" | "resting" | "completed" | "failed"

export type OfficeAmbientAction = "idle" | "computer" | "tea" | "reading" | "copying" | "strolling" | "chatting"

export interface OfficeActivity {
  runId: string
  parentRunId?: string
  sessionId: string
  agentId: string
  agentName?: string
  /** 办公室人物的专业岗位，人物姓名与后台 Agent 名称分开显示。 */
  agentRole?: string
  state: OfficeAgentState
  activity: string
  toolName?: string
  timestamp: number
  /** 仅用于展示员工名册，不对应后台 task/run。 */
  synthetic?: boolean
  /** 待命员工的办公室生活动作；真实任务状态始终优先。 */
  ambientAction?: OfficeAmbientAction
  ambientStep?: number
  ambientSeat?: 0 | 1
}

export interface OfficeSnapshot {
  agents: OfficeActivity[]
  timeline: OfficeActivity[]
}

export type OfficeOutfit = "casual" | "formal" | "lab" | "hoodie" | "night-flight"
export type OfficeFestival = "auto" | "none" | "spring" | "summer" | "autumn" | "winter" | "lunar"

export interface OfficePoint {
  x: number
  y: number
}

export interface OfficeAppearance {
  outfit: OfficeOutfit
  characterId?: string
  avatarDataUrl?: string
}

export interface OfficeFurniturePlacement extends OfficePoint {
  instanceId: string
  itemId: string
  rotation: 0 | 90 | 180 | 270
}

export interface OfficePreferences {
  sceneSchemaVersion: number
  positions: Record<string, OfficePoint>
  zonePositions: Record<string, OfficePoint>
  appearances: Record<string, OfficeAppearance>
  festival: OfficeFestival
  activePackId: string
  furniture: OfficeFurniturePlacement[]
}

export interface OfficeDailyStats {
  date: string
  hourly: number[]
  tools: Record<string, number>
  activities: number
  failures: number
}

export interface OfficeProgression {
  version: 1
  xp: number
  researchPoints: number
  completedTasks: number
  streakDays: number
  lastCompletionDate?: string
  rewardedRunIds: string[]
  unlockedAchievementIds: string[]
}
