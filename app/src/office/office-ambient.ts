import { agentHomePosition } from "./office-workstations"
import type { OfficeActivity, OfficeAmbientAction, OfficePoint } from "./types"

/** 名义采样周期；每位员工会根据自己的种子获得 28～64 秒的独立停留周期。 */
export const AMBIENT_INTERVAL_MS = 31_000
const MIN_PERSONAL_HOLD_MS = 28_000
const PERSONAL_HOLD_VARIANCE_MS = 37_000
const CHAT_INTERVAL_MS = 67_000

// 停留占更高权重，避免所有员工一直在办公室里来回走。
const PERSONAL_ACTIONS: Array<Exclude<OfficeAmbientAction, "chatting">> = [
  "idle", "idle", "idle", "computer", "tea", "reading", "copying", "strolling",
]
const PROJECT_TOPICS = ["版本里程碑", "固件联调", "界面体验", "测试风险", "需求边界", "下一个迭代"]

const ACTION_TEXT: Record<Exclude<OfficeAmbientAction, "chatting">, string[]> = {
  idle: ["在原地停留一会儿，安静观察办公室", "暂时没有走动，顺手整理随身物品", "停下来想想接下来做什么"],
  computer: ["在工位玩一会儿电脑，整理项目便签", "浏览团队看板，看看有没有新鲜事"],
  tea: ["在咖啡角泡茶，顺便给思路降温", "端着热茶补充一点温和算力"],
  reading: ["在资料室翻看技术书", "找了本数据手册随手读几页"],
  copying: ["在复印机旁复制项目资料", "把评审材料复印成团队份数"],
  strolling: ["在办公室里随意走走，看看谁需要帮忙", "沿着过道散步，顺便观察项目进展"],
}

const ACTION_LABELS: Record<OfficeAmbientAction, string> = {
  idle: "停留中", computer: "玩电脑", tea: "喝茶中", reading: "看书中", copying: "复印资料", strolling: "散步中", chatting: "项目闲聊",
}

/**
 * 给待命员工安排稳定但不整齐同步的生活动作。
 * 这里使用员工 ID 和时间段生成伪随机结果，避免 React 每秒刷新时人物抖动，
 * 同时让不同员工拥有不同停留时长、出发时刻和动作顺序。
 */
export function applyAmbientSchedule(activities: OfficeActivity[], now: number): OfficeActivity[] {
  const standbyIndexes = activities.flatMap((activity, index) => activity.state === "standby" ? [index] : [])
  const pairCount = Math.floor(standbyIndexes.length / 2)
  const chatStep = Math.floor(now / CHAT_INTERVAL_MS)
  const chatSeed = stableHash(`office-chat:${chatStep}`)
  const activePair = pairCount > 0 && chatSeed % 3 === 0 ? chatSeed % pairCount : -1
  const chatIndexes = activePair >= 0 ? standbyIndexes.slice(activePair * 2, activePair * 2 + 2) : []
  const firstChat = chatIndexes[0] === undefined ? null : activities[chatIndexes[0]]
  const secondChat = chatIndexes[1] === undefined ? null : activities[chatIndexes[1]]
  const topic = PROJECT_TOPICS[stableHash(`${firstChat?.agentId}:${secondChat?.agentId}:${chatStep}`) % PROJECT_TOPICS.length]

  return activities.map((activity, index) => {
    // A real task always preempts office-life simulation. Clear any ambient
    // fields left by an earlier standby render so a working employee can
    // neither keep a leisure label nor be routed to a leisure destination.
    if (activity.state !== "standby") return withoutAmbientAction(activity)
    const chatSeat = chatIndexes.indexOf(index)
    if (chatSeat >= 0 && firstChat && secondChat) {
      const peer = chatSeat === 0 ? secondChat : firstChat
      return {
        ...activity,
        ambientAction: "chatting",
        ambientStep: chatStep,
        ambientSeat: chatSeat as 0 | 1,
        activity: `在沙发上和${peer.agentName ?? peer.agentId}讨论「${topic}」`,
      }
    }

    const holdMs = MIN_PERSONAL_HOLD_MS + stableHash(`${activity.agentId}:hold`) % PERSONAL_HOLD_VARIANCE_MS
    const offset = stableHash(`${activity.agentId}:offset`) % holdMs
    const localStep = Math.floor((now + offset) / holdMs)
    const actionSeed = stableHash(`${activity.agentId}:action:${localStep}`)
    const action = PERSONAL_ACTIONS[actionSeed % PERSONAL_ACTIONS.length]
    const texts = ACTION_TEXT[action]
    return {
      ...activity,
      ambientAction: action,
      ambientStep: localStep,
      ambientSeat: undefined,
      activity: texts[actionSeed % texts.length],
    }
  })
}

export function withoutAmbientAction(activity: OfficeActivity): OfficeActivity {
  if (
    activity.ambientAction === undefined
    && activity.ambientStep === undefined
    && activity.ambientSeat === undefined
  ) return activity
  const { ambientAction: _action, ambientStep: _step, ambientSeat: _seat, ...taskActivity } = activity
  return taskActivity
}

export function ambientPosition(agent: OfficeActivity, ordinal: number, movedZones: Record<string, OfficePoint>): { x: number; y: number; zone: string } {
  const action = agent.ambientAction
  const variant = stableHash(agent.agentId) % 3
  if (!action || action === "idle" || action === "computer") return agentHomePosition(agent.agentId, ordinal, movedZones)
  if (action === "chatting") {
    const seat = agent.ambientSeat ?? 0
    const lounge = movedZones["lounge-access"] ?? { x: 18, y: 67 }
    return { x: lounge.x + (seat === 0 ? -7 : 7), y: lounge.y + seat, zone: "休息区沙发" }
  }
  if (action === "tea") {
    const coffee = movedZones["coffee-access"] ?? movedZones.coffee ?? { x: 33, y: 79 }
    return { x: coffee.x + (variant - 1) * 6, y: coffee.y + variant * 1.5, zone: "咖啡角" }
  }
  if (action === "reading") {
    const docs = movedZones["docs-access"] ?? movedZones.docs ?? { x: 83, y: 29 }
    return { x: docs.x + (variant - 1) * 6, y: docs.y + variant * 1.5, zone: "资料室" }
  }
  if (action === "copying") {
    const printer = movedZones["printer-access"] ?? movedZones.printer ?? { x: 76, y: 82 }
    return { x: printer.x + (variant - 1) * 6, y: printer.y + variant * 1.5, zone: "打印复印区" }
  }
  const strollPoints = [
    { x: 39, y: 49, zone: "中央过道" }, { x: 56, y: 67, zone: "项目过道" },
    { x: 34, y: 72, zone: "茶水间过道" }, { x: 63, y: 48, zone: "实验室过道" },
  ]
  const point = strollPoints[stableHash(`${agent.agentId}:stroll:${agent.ambientStep ?? 0}`) % strollPoints.length]
  return { ...point, x: point.x + ((ordinal % 3) - 1) * 4 }
}

export function ambientLabel(action?: OfficeAmbientAction): string | null {
  return action ? ACTION_LABELS[action] : null
}

function stableHash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}
