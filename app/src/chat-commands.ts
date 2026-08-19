const COMMANDS: Array<{ key: string; prompt: string }> = [
  { key: "/init", prompt: "请直接使用当前 Agent 的本地只读工具分析当前工作目录，不要委派 task 子 Agent。执行以下步骤：\n1. 使用 glob 的 patterns 参数在一次调用中批量搜索项目文件、原理图、芯片手册和数据手册，禁止按扩展名重复扫描\n2. 仅对实际匹配到的原理图调用 schematic_read，对实际匹配到的数据手册调用 datasheet_read；找不到时明确说明，不要臆造\n3. 使用 read/grep 分析项目结构、芯片型号、构建系统和开发环境\n4. 输出项目初始化报告：项目概览、原理图摘要、芯片参数、构建方式、风险和下一步建议" },
  { key: "/compact", prompt: "请为当前对话生成结构化的压缩摘要，严格按以下格式输出，不要使用 Markdown 表格语法：\n\n1. **用户需求**：列出用户的核心需求（每行一条）\n2. **已完成操作**：列出已执行的关键操作和结果（每行一条）\n3. **项目状态**：列出当前项目的关键状态（每行一条）\n4. **待解决问题**：列出尚未解决的问题或后续计划（每行一条）\n\n每个部分之间用空行分隔。不要使用 | 表格语法。" },
  { key: "/review", prompt: "请审查当前工作区的改动，检查代码质量、潜在bug、编译风险，输出审查报告。" },
  { key: "/commit", prompt: "请审查所有改动，生成规范的 git commit 信息并提交。信息要求：1) 前缀（docs/fix/feat/refactor） 2) 从用户角度说明为什么改 3) 具体到哪些文件/模块。不要用模糊描述。如果有冲突不要修复，通知我。" },
  { key: "/learn", prompt: "分析本次会话，提取非显而易见的经验教训写入 AGENTS.md。包括：隐藏的文件/模块关系、编译器/工具链配置、芯片硬件限制、调试突破点。已存在的内容不要重复。保持每条 1-3 行。" },
  { key: "/changelog", prompt: "请从 git log 中提取自上一个版本以来的所有变更，生成结构化的 CHANGELOG.md。" },
  { key: "/translate", prompt: "请翻译以下内容。专业术语（寄存器名、引脚名、协议名）保留原文。" },
]

export const HELP_TEXT = [
  "| 命令 | 功能 |", "|------|------|",
  "| `/init` | 分析目录，初始化嵌入式项目结构 |",
  "| `/review` | 审查当前工作区所有改动 |",
  "| `/compact` | 总结对话，压缩上下文释放 token |",
  "| `/commit` | 生成规范的 git commit 信息并提交 |",
  "| `/learn` | 从会话提取经验写入 AGENTS.md |",
  "| `/changelog` | 从 git log 生成 CHANGELOG.md |",
  "| `/translate` | 翻译嵌入式技术文档（中↔英） |",
  "| `/clear` | 清空当前会话消息、模型上下文和待处理任务 |",
  "| `/help` | 显示此帮助信息 |",
].join("\n")

export function expandCommand(text: string): string {
  const trimmed = text.trim()
  const key = trimmed.split(" ")[0]
  const command = COMMANDS.find((item) => item.key === key)
  if (!command) return trimmed
  const rest = trimmed.slice(key.length).trim()
  return command.prompt + (rest ? ` ${rest}` : "")
}

export function unmaskCommand(content: string): string {
  for (const command of COMMANDS) {
    if (content === command.prompt || content.startsWith(command.prompt)) {
      return content.replace(command.prompt, command.key)
    }
  }
  return content
}
