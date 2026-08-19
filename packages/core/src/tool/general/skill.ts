import { defineTool } from "../define"
import { discoverSkills, isPortableSkillName } from "../../skills/loader"

export const skillTool = defineTool({
  name: "skill",
  description: "加载预定义的技能/工作流指令（如 STM32 HAL、LVGL 初始化、FreeRTOS 配置、系统架构审计等）。返回完整 Markdown 内容。",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "技能名称（如 stm32-hal / architecture-audit）" },
    },
    required: ["name"],
  },
  async execute({ name }: { name: string }, ctx) {
    if (!isPortableSkillName(name)) {
      return { success: false, error: "技能名称只能包含小写字母、数字和连字符" }
    }
    const disabled = new Set(ctx.disabledSkillIds ?? [])
    const skills = discoverSkills(ctx.workingDir).filter((skill) => !disabled.has(skill.name))
    const found = skills.find((s) => s.name === name)
    if (found) {
      return {
        success: true,
        data: {
          skill: found.name,
          description: found.description,
          content: found.content,
          source: found.source,
          baseDir: found.baseDir || undefined,
          note: found.baseDir ? "Skill 中的相对文件路径以 baseDir 为基准；按需读取配套资源。" : undefined,
        },
      }
    }

    // 未找到
    const available = skills.map((s) => s.name).join(", ")
    return { success: false, error: `技能 "${name}" 未找到。可用技能: ${available || "(无)"}` }
  },
  contract: { effects: ["workspace-read"], idempotency: "read-only", cancellation: "unsupported", progress: { role: "inspection" } }, permission: "skill",
})
