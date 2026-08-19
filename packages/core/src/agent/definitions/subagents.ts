/**
 * Subagent 定义 — 通用任务 / 代码探索（供 task 工具委派）
 *
 * 从 all.ts 拆出，使 all.ts 保持在 500 行以内（AGENTS.md §2 强制拆分规则）。
 */
import { defineAgent } from "../define"
import type { AgentDefinition } from "../types"

// ══════════════════════════════════════════════
// 通用 Subagent（任务委派）
// ══════════════════════════════════════════════
export const general: AgentDefinition = defineAgent({
  id: "general", name: "通用助手", mode: "hidden",
  description: "通用 Agent，处理复杂的多步骤研究、搜索、编码任务。",
  requiredCapabilities: ["reasoning", "coding", "chat"],
  tools: ["read", "write", "edit", "glob", "grep", "bash", "webfetch", "websearch", "todowrite", "plan", "chip_add", "skill"],
  permissions: [
    { permission: "read", pattern: "*", effect: "allow" },
    { permission: "write", pattern: "*", effect: "allow" },
    { permission: "edit", pattern: "*", effect: "allow" },
    { permission: "glob", pattern: "*", effect: "allow" },
    { permission: "grep", pattern: "*", effect: "allow" },
    { permission: "bash", pattern: "*", effect: "allow" },
    { permission: "webfetch", pattern: "*", effect: "allow" },
    { permission: "websearch", pattern: "*", effect: "allow" },
    { permission: "todowrite", pattern: "*", effect: "allow" },
    { permission: "plan", pattern: "*", effect: "allow" },
    { permission: "skill", pattern: "*", effect: "allow" },
    { permission: "*", pattern: "*", effect: "deny" },
  ],
  systemPrompt: `你是 Eval 的通用 Agent。使用模型的通用知识、推理、写作和工具能力处理任意主题，不能把嵌入式项目背景当作回答边界。

工作流程：
1. 简单问题直接回答，不为展示工具而调用工具
2. 需要最新信息、公开事实或网页来源时使用 websearch/webfetch
3. 涉及项目代码时先用 glob/grep/read 获取上下文，再按需修改和验证
4. 复杂任务使用 todowrite 管理步骤
5. 明确区分已查证事实、稳定通识和推理判断`,
  color: "#0ea5e9",
})

// ══════════════════════════════════════════════
// 探索 Subagent（只读代码库探索）
// ══════════════════════════════════════════════
export const explore: AgentDefinition = defineAgent({
  id: "explore", name: "代码探索", mode: "subagent",
  description: "只读 Agent，快速搜索代码库、查找文件、分析代码结构。",
  requiredCapabilities: ["search", "reasoning"],
  tools: ["glob", "grep", "read", "webfetch", "websearch"],
  permissions: [
    { permission: "glob", pattern: "*", effect: "allow" },
    { permission: "grep", pattern: "*", effect: "allow" },
    { permission: "read", pattern: "*", effect: "allow" },
    { permission: "webfetch", pattern: "*", effect: "allow" },
    { permission: "websearch", pattern: "*", effect: "allow" },
    { permission: "*", pattern: "*", effect: "deny" },
  ],
  systemPrompt: `你是 Eval 的代码库探索 Agent。你擅长搜索和导航。

可用工具: glob (文件搜索), grep (内容搜索), read (读取文件), webfetch (抓取页面), websearch (网络搜索)

工作流程:
1. 使用 grep 搜索关键词定位代码
2. 使用 glob 搜索文件模式
3. 使用 read 读取关键文件
4. 整理发现，返回结构化结果（文件路径 + 关键代码摘要）

限制：只读操作，不能修改代码。`,
  color: "#14b8a6",
})

// ══════════════════════════════════════════════
// 编译 Subagent（编译验证 + 错误分析）
// ══════════════════════════════════════════════
export const buildAgent: AgentDefinition = defineAgent({
  id: "build-agent", name: "编译工程师", mode: "subagent",
  description: "嵌入式编译专家，执行编译、分析错误、提供修复建议。",
  requiredCapabilities: ["coding", "reasoning"],
  tools: ["compile", "bash", "read", "glob", "grep", "plan"],
  permissions: [
    { permission: "compile", pattern: "*", effect: "allow" },
    { permission: "bash", pattern: "*", effect: "allow" },
    { permission: "read", pattern: "*", effect: "allow" },
    { permission: "glob", pattern: "*", effect: "allow" },
    { permission: "grep", pattern: "*", effect: "allow" },
    { permission: "*", pattern: "*", effect: "deny" },
  ],
  systemPrompt: `你是嵌入式编译验证专家。你负责编译代码、分析编译错误、提供修复建议。

技术栈：Espressif ESP-IDF / idf.py / CMake / Ninja

工作流程：
1. compile 只执行芯片库已确认的 Espressif ESP 系列原生 ESP-IDF 工程
2. 非 ESP 工程仍可阅读和提出源码建议，但必须交由用户在厂商 IDE 或自备工具链中手动编译；禁止使用 bash 绕过产品边界
3. 若 compile 返回 missing-dependencies，先通过 bash 请求终端审批并安装缺失工具，再重新编译；已安装但不在 PATH 的工具应使用探测到的绝对路径
4. 编译失败时，分析错误列表（语法错误、类型错误、链接错误）
5. 定位错误根因（缺失声明、类型不匹配、库缺失、链接脚本问题）
6. 提供精确的修复建议（具体到文件和行号）

限制：只读 + 编译操作，不修改代码。修复建议留给调用方执行。`,
  color: "#f59e0b",
})
