import type { OfficeActivity } from "./types"

export interface OfficePersona {
  name: string
  role: string
}

const PERSONA_NAMES: Record<string, string> = {
  general: "小伊",
  "project-initializer": "启启",
  researcher: "星芽",
  "requirements-collector": "果果",
  "requirements-analyst": "小愿",
  "schematic-analyst": "欧姆",
  "hardware-engineer": "铜豆",
  "software-engineer": "码可",
  "firmware-dev": "阿芯",
  "firmware-engineer": "芯仔",
  "ui-dev": "糖糖",
  "ui-engineer": "彩芽",
  architect: "阿筑",
  "os-engineer": "核桃",
  "test-engineer": "点点",
  "doc-writer": "墨墨",
  planner: "小策",
  "debug-assistant": "小探",
  "debug-engineer": "探探",
  "build-agent": "炉炉",
}

const EXTRA_NAMES = ["团子", "柚子", "米粒", "泡芙", "布丁", "栗子", "桃桃", "悠悠", "小满", "芽芽"]

export function officePersona(agentId: string, roleName?: string): OfficePersona {
  return {
    name: PERSONA_NAMES[agentId] ?? EXTRA_NAMES[stableHash(agentId) % EXTRA_NAMES.length],
    role: roleName?.trim() || "数字员工",
  }
}

export function withOfficePersona(activity: OfficeActivity, roleName?: string): OfficeActivity {
  const role = activity.agentRole || roleName || activity.agentName
  const persona = officePersona(activity.agentId, role)
  return { ...activity, agentName: persona.name, agentRole: persona.role }
}

function stableHash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}
