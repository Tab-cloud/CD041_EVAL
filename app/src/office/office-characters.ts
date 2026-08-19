export interface OfficeCharacterProfile {
  id: string
  name: string
  description: string
}

export const OFFICE_CHARACTER_PROFILES: OfficeCharacterProfile[] = [
  { id: "taotao", name: "桃桃", description: "暖棕短发与青蓝工作夹克" },
  { id: "xingya", name: "星芽", description: "卷发、圆框眼镜与紫色夹克" },
  { id: "momo", name: "墨墨", description: "高丸子卷发与琥珀色工装" },
  { id: "xinzai", name: "芯仔", description: "银灰短发与浅蓝技术衬衫" },
  { id: "caiya", name: "彩芽", description: "深色侧辫与珊瑚红开衫" },
  { id: "hetang", name: "核桃", description: "薄荷短发、眼镜与技术马甲" },
  { id: "oumu", name: "欧姆", description: "短胡须与鼠尾草绿开衫" },
]

const PROFILE_IDS = new Set(OFFICE_CHARACTER_PROFILES.map((profile) => profile.id))

const CHARACTER_BY_AGENT: Record<string, string> = {
  general: "taotao",
  "project-initializer": "hetang",
  researcher: "xingya",
  explore: "xingya",
  "requirements-collector": "caiya",
  "requirements-analyst": "caiya",
  "schematic-analyst": "oumu",
  "hardware-engineer": "xinzai",
  "component-researcher": "momo",
  "software-engineer": "hetang",
  "firmware-dev": "xinzai",
  "firmware-engineer": "xinzai",
  "ui-dev": "taotao",
  "ui-engineer": "taotao",
  architect: "oumu",
  "os-engineer": "xingya",
  "test-engineer": "momo",
  "doc-writer": "momo",
  planner: "caiya",
  "debug-assistant": "taotao",
  "debug-engineer": "xinzai",
  "build-agent": "oumu",
}

export function officeCharacterProfile(agentId: string, requestedId?: string): OfficeCharacterProfile {
  const id = requestedId && PROFILE_IDS.has(requestedId)
    ? requestedId
    : CHARACTER_BY_AGENT[agentId] ?? OFFICE_CHARACTER_PROFILES[stableHash(agentId) % OFFICE_CHARACTER_PROFILES.length].id
  return OFFICE_CHARACTER_PROFILES.find((profile) => profile.id === id) ?? OFFICE_CHARACTER_PROFILES[0]
}

function stableHash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}
