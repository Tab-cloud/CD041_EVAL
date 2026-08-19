/**
 * Planner — 任务分解器 (Goose + CrewAI 混合模式)
 *
 * 模式: LLM 驱动的 Plan-and-Execute
 * 输入用户目标 → LLM 拆解为子任务列表 → 顺序执行 → 反馈进度
 */
import type { AgentDefinition } from "../agent/types"

export interface SubTask {
  id: string
  title: string
  description: string
  agentId: string
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  dependsOn: string[]       // 前置依赖的子任务 ID
  result?: string
  error?: string
}

export interface Plan {
  goal: string
  tasks: SubTask[]
  createdAt: number
  currentTaskIndex: number
}

export class TaskDecomposer {
  /**
   * 使用 LLM 将用户目标分解为子任务列表
   * 参考 Goose: 提示模型"先规划再执行"
   */
  buildDecompositionPrompt(goal: string, availableAgents: AgentDefinition[]): string {
    const agentList = availableAgents
      .map((a) => `- **${a.id}** (${a.name}): ${a.description}`)
      .join("\n")

    return `你是一个嵌入式项目规划专家。请将以下目标分解为可执行的子任务列表。

## 目标
${goal}

## 可用 Agent
${agentList}

## 输出格式
请严格按以下 JSON 格式输出（不要包含其他内容）：
\`\`\`json
{
  "tasks": [
    {
      "title": "任务标题",
      "description": "具体要做的事情",
      "agentId": "对应的 agent id",
      "dependsOn": []
    }
  ]
}
\`\`\`

## 分解原则
1. 每个子任务应独立可执行，有明确的输入输出
2. 标注子任务间的前置依赖关系
3. 硬件分析 (hardware-engineer) 先于软件开发 (software-engineer/firmware-engineer)
4. 编译烧录 (firmware-engineer) 在代码编写之后
5. 测试 (test-engineer) 在编译之后
6. 文档 (doc-writer) 在最后
7. 如果有原理图，优先让 hardware-engineer 分析
8. 子任务数量控制在 3-8 个`
  }

  /** 解析 LLM 返回的 JSON */
  parsePlan(raw: string, goal: string): Plan | null {
    try {
      // 提取 JSON 块
      const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) ?? raw.match(/(\{[\s\S]*\})/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[1])
      if (!parsed.tasks || !Array.isArray(parsed.tasks)) return null

      const tasks: SubTask[] = parsed.tasks.map((t: any, i: number) => ({
        id: `task-${i + 1}`,
        title: t.title ?? `Task ${i + 1}`,
        description: t.description ?? "",
        agentId: t.agentId ?? "firmware-engineer",
        status: "pending" as const,
        dependsOn: t.dependsOn ?? [],
      }))

      return { goal, tasks, createdAt: Date.now(), currentTaskIndex: 0 }
    } catch {
      return null
    }
  }

  /** 获取下一个可执行的任务 */
  nextTask(plan: Plan): SubTask | null {
    for (let i = plan.currentTaskIndex; i < plan.tasks.length; i++) {
      const task = plan.tasks[i]
      if (task.status !== "pending") continue

      // 检查前置依赖是否都已完成
      const depsMet = task.dependsOn.every((depId) => {
        const dep = plan.tasks.find((t) => t.id === depId)
        return dep?.status === "completed" || dep?.status === "skipped"
      })

      if (depsMet) {
        plan.currentTaskIndex = i
        return task
      }
    }
    return null
  }

  /** 生成计划进度报告 */
  progressReport(plan: Plan): string {
    const lines = [
      `## 执行计划: ${plan.goal}`,
      "",
      "| # | 任务 | Agent | 状态 |",
      "|---|------|-------|------|",
    ]
    for (const t of plan.tasks) {
      const icon = t.status === "completed" ? "[done]" : t.status === "failed" ? "[fail]" : t.status === "running" ? "[run]" : "[ ]"
      lines.push(`| ${t.id} | ${t.title} | ${t.agentId} | ${icon} ${t.status} |`)
    }
    const done = plan.tasks.filter((t) => t.status === "completed").length
    lines.push("", `**进度: ${done}/${plan.tasks.length}**`)
    return lines.join("\n")
  }
}
