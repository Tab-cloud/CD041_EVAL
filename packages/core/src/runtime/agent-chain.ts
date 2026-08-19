/**
 * AgentChain — 多 Agent 串行/条件编排 (AutoGen Handoff + CrewAI Sequential)
 *
 * WORKFLOWS 已用于工作流路由；串行执行器保留供后续扩展。
 *
 * 模式:
 *   Handoff: Agent A 调用 handoff 工具 → 传递消息给 Agent B
 *   Sequential: PM → Architect → Coder → Tester → Reviewer
 *   Context flow: 上一个 Agent 的输出 → 下一个 Agent 的输入
 */
import type { AgentDefinition } from "../agent/types"

export interface ChainStep {
  agent: AgentDefinition
  /** 传递给这个 Agent 的上下文消息 */
  contextMessage: string
  /** 上一个 Agent 的结果 */
  previousResult?: string
}

export interface ChainResult {
  steps: Array<{ agentId: string; agentName: string; output: string; success: boolean }>
  finalOutput: string
  completed: boolean
}

export class AgentChain {
  /**
   * 构建 Handoff 消息（AutoGen 模式）
   * Agent A → Agent B 的交接消息
   */
  buildHandoff(from: AgentDefinition, to: AgentDefinition, context: string): string {
    return [
      `[Handoff: ${from.name} → ${to.name}]`,
      ``,
      `## 上下文`,
      context,
      ``,
      `## 你的任务`,
      `作为 **${to.name}**，请基于上述上下文继续完成你的专业工作。`,
    ].join("\n")
  }

  /**
   * 执行串行 Agent 链
   * 参考 CrewAI: 按顺序遍历任务列表，上下文向前传递
   */
  buildSequentialPlan(
    goal: string,
    agents: AgentDefinition[],
  ): ChainStep[] {
    const steps: ChainStep[] = []
    let context = goal

    for (let i = 0; i < agents.length; i++) {
      const prevAgent = agents[i - 1]
      const currentAgent = agents[i]

      const contextMessage =
        i === 0
          ? goal
          : this.buildHandoff(prevAgent!, currentAgent, context)

      steps.push({ agent: currentAgent, contextMessage })
    }

    return steps
  }

  /**
   * 预定义的工作流模板
   */
  static readonly WORKFLOWS: Record<string, string[]> = {
    /** 完整嵌入式开发流程 */
    "full-development": [
      "requirements-analyst",   // 1. 需求分析
      "hardware-engineer",      // 2. 硬件分析
      "architect",              // 3. 架构设计
      "firmware-engineer",      // 4. 固件开发
      "test-engineer",          // 5. 测试验证
      "doc-writer",             // 6. 文档生成
    ],
    /** 快速原型流程 */
    "quick-prototype": [
      "hardware-engineer",      // 1. 硬件分析
      "firmware-engineer",      // 2. 固件开发
      "test-engineer",          // 3. 编译测试
    ],
    /** 调试流程 */
    "debugging": [
      "debug-engineer",         // 1. 串口/SWD 调试
      "test-engineer",          // 2. 测试验证
      "firmware-engineer",      // 3. 代码修复（如需要）
    ],
    /** 器件选型流程 */
    "component-selection": [
      "requirements-analyst",   // 1. 需求分析
      "component-researcher",   // 2. 器件搜索/对比
      "architect",              // 3. 方案评审
    ],
    /** UI 开发流程 */
    "ui-development": [
      "hardware-engineer",      // 1. 确认屏幕接口
      "ui-engineer",            // 2. LVGL 开发
      "test-engineer",          // 3. 测试
    ],
  }

  /**
   * 构建 Chain 执行的结果摘要
   */
  summarizeResult(result: ChainResult): string {
    if (result.steps.length === 0) return "无执行步骤"

    const lines = [
      `## Agent Chain 执行结果`,
      ``,
      `| 步骤 | Agent | 状态 |`,
      `|------|-------|------|`,
    ]

    for (const step of result.steps) {
      const icon = step.success ? "[done]" : "[fail]"
      lines.push(`| ${step.agentName} | ${step.agentId} | ${icon} |`)
    }

    lines.push("", result.finalOutput)
    return lines.join("\n")
  }
}
