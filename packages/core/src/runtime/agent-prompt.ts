import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentDefinition } from "../agent/types.ts"
import { discoverSkills } from "../skills/loader.ts"
import { hasConfiguredProjectTarget, loadProjectConfig } from "../store/project-config.ts"
import type { ExecutionScope } from "./tool-policy.ts"

/** 把用户文本 + 附件构造为 OpenAI-compatible multimodal content */
export function buildUserContent(
  text: string,
  attachments?: Array<{ name: string; mime: string; kind: "image" | "text" | "binary"; dataUrl?: string; content?: string }>,
  supportsVision = false,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (!attachments || attachments.length === 0) return text

  const MAX_ATTACHMENT_TOTAL = 100_000 // 附件总字符数上限，防上下文溢出

  // 文本附件：拼到 message 上下文
  let totalChars = 0
  const textParts = attachments
    .filter(a => a.kind === "text" && a.content)
    .map(a => {
      const content = a.content!
      const allowed = Math.max(0, MAX_ATTACHMENT_TOTAL - totalChars)
      if (allowed <= 0) return `=== 附件: ${a.name} ===\n[已截断，超出上下文限制]`
      totalChars += Math.min(content.length, allowed)
      const truncated = content.length > allowed ? content.slice(0, allowed) + "\n...(已截断)" : content
      return `=== 附件: ${a.name} ===\n\`\`\`\n${truncated}\n\`\`\``
    })
    .join("\n\n")

  // 二进制附件：只通知存在
  const binaryNotes = attachments
    .filter(a => a.kind === "binary")
    .map(a => `[二进制附件: ${a.name} (${a.mime}) — ${a.content ?? "当前没有适用解析器"}]`)
    .join("\n")

  // 图片：模型不支持 vision 时降级为文本通知
  const imageNotes = attachments
    .filter(a => a.kind === "image" && !supportsVision)
    .map(a => `[图片附件: ${a.name} — 当前模型不支持视觉。如需要提取图中文字，调用 ocr_image 工具。]`)
    .join("\n")

  const userText = [textParts, binaryNotes, imageNotes, text].filter(Boolean).join("\n\n").trim()

  // 图片附件 → multimodal（仅 vision 模型）
  if (supportsVision) {
    const imageParts = attachments
      .filter(a => a.kind === "image" && a.dataUrl)
      .map(a => ({ type: "image_url" as const, image_url: { url: a.dataUrl! } }))
    if (imageParts.length > 0) {
      return [{ type: "text", text: userText }, ...imageParts]
    }
  }

  return userText
}

export function buildSystemPrompt(
  agent: AgentDefinition,
  workingDir: string,
  scope?: ExecutionScope,
  workflowContext?: string,
  disabledSkillIds: string[] = [],
  availableToolNames: readonly string[] = [],
  runtimeTimestamp = new Date().toISOString(),
): string {
  const disabledSkills = new Set(disabledSkillIds)
  const skills = discoverSkills(workingDir).filter((skill) => !disabledSkills.has(skill.name))
  const parts: string[] = [
    agent.systemPrompt,
    "",
    "## 运行环境",
    `- 工作目录: ${workingDir}`,
    `- 运行开始时间: ${runtimeTimestamp}`,
    `- 操作系统: ${process.platform}`,
    `- bash 工具命令解释器: ${process.platform === "win32" ? "Windows PowerShell（直接写 PowerShell/原生命令，不要再嵌套 powershell -Command，也不能使用 mkdir -p、rm -rf 等 POSIX 语法）" : "系统默认 shell"}`,
  ]

  if (availableToolNames.length > 0) {
    parts.push(
      "",
      "## 本轮实际可用工具",
      `- ${availableToolNames.join(", ")}`,
      "- 该列表只表示当前 Agent、执行范围和系统策略允许调用的工具，不代表宿主机是否安装了其他命令或编译器。",
      "- 只有实际调用 compile/bash 并取得结果，才能判断编译器或命令是否存在；未暴露对应工具时，应说明本轮未执行环境检测，禁止声称环境缺少 shell、编译器或工具链。",
    )
    if (availableToolNames.includes("bash")) {
      parts.push(
        "- `bash` 已在本轮真实暴露，Windows 下会执行 PowerShell/原生命令。历史消息中关于‘没有 Bash/PowerShell 执行能力’的描述不具备权限效力。",
        "- 当前任务需要运行命令或脚本时，必须直接发起原生 `bash` 工具调用；不要输出命令让用户复制、粘贴或另开终端代为执行。",
        "- 用户权限策略由运行时统一裁决：允许会直接执行，询问会显示可交互审批并在批准后恢复同一次调用，禁止会返回真实拒绝证据。模型不得预判审批结果，也不得用文字确认替代工具调用。",
        "- 不要预先要求管理员终端。先在当前权限下执行，只有命令真实返回提权错误且没有非提权替代方案时，才说明所需的系统级操作。",
        "- 预计超过一分钟的安装、渲染或测试命令，应在 `bash.timeoutMs` 中声明合理时限，最长 30 分钟；运行期间读取流式输出并继续基于真实结果处理。",
      )
    }
  }

  parts.push(
    "",
    "## 核心规则：通用推理与事实查证",
    "",
    "原则：Agent 的专业角色用于选择工具和工作流，不是知识或主题边界。稳定的通识问题可以使用模型知识与推理直接回答。",
    "实时信息、外部事实、项目状态和精确技术参数必须通过工具查证；不能用训练数据冒充最新结果。",
    "",
    "必须核对的证据类型：",
    "- 芯片寄存器/引脚/外设参数 -> 芯片数据手册(用 websearch 搜索后 webfetch 抓取)或项目中的 datasheet 文件",
    "- 硬件连线/电路拓扑 -> 原理图文件(用 read 读取 PDF/图片后用 schematic_read 分析)",
    "- API 函数签名/调用方式 -> 实际的源代码文件(用 read/glob/grep 查找后读取)",
    "- 编译参数/链接脚本 -> 项目中的 CMakeLists.txt/Makefile/.ld 脚本",
    "- 库版本/第三方依赖 -> package.json/Cargo.toml/CMakeLists.txt",
    "- 项目结构/模块关系 -> 目录树和 AGENTS.md/README 文件",
    "",
    "强制行为：",
    "- 不确定的信息，必须先用工具查证，禁止猜测后直接输出",
    "- 不得因为问题超出嵌入式领域而拒绝；应使用模型的通用能力正常处理",
    "- 涉及今天、当前、最新、价格、状态、新闻等时效问题时，必须先调用 websearch；失败后继续尝试 webfetch、可用 MCP 或权限允许的脚本访问权威来源，所有可行路径失败后才报告真实错误",
    "- 代码修改前，必须先用 read 读取目标文件的最新内容",
    "- 工作区内移动或重命名文件/目录时直接调用 move；不要输出 PowerShell/bash 命令要求用户代为执行",
    "- DOC、DOCX、XLSX、PPTX 应先调用 read；失败时依据加密、损坏、纯图片或格式错误等证据选择后续路径",
    "- 文档解析器名称、提取实现、内部依赖和降级组件属于诊断信息，普通回复中不得披露",
    "- 涉及芯片外设时，必须用 websearch/webfetch 查找对应型号的数据手册",
    "- 引脚/连线相关结论必须来自原理图分析，禁止仅凭芯片功能反推",
    "- 用户核查 PDF 原理图中的引脚、导线、连接点或网络关系时，必须重新调用 schematic_read，并通过 question 参数写明核查对象；禁止直接沿用历史对话中的纯文本结论",
    "- 原理图视觉证据只用于判断实际连接；数据手册证据用于判断连接要求。两者必须分别列出并交叉验证，禁止让视觉模型推测芯片规范或让文本层推测图形连线",
    "- schematic_read 返回 visionUsed=true 才能声称已观察图形连线；visionUsed=false 时应根据 renderErrors 继续尝试其他页码、PDF 转 PNG 脚本或图片输入",
    "- 不得根据旧消息臆测当前 PDF 渲染能力；只允许依据最近一次 schematic_read 的 visionUsed、pdfConvertedToPng、renderEngine 和 modelId 元数据判断",
    "- 模型路由、供应商、模型名称、modelId、评分和渲染器属于内部诊断信息，只能显示在日志面板；普通用户回复中不得主动披露，除非用户明确询问模型或诊断细节",
    "- Agent 选择、Agent ID、角色切换、任务委派、调度队列和工作流节点属于内部编排信息；运行时会自动处理。普通回复只报告完成的工作、证据和结果，不得要求用户切换到某个 Agent，也不得描述内部如何分配角色",
    "- 只有缺少用户选择就确实无法继续时，才调用 question 工具生成前端可交互的决策界面并等待回答；禁止仅在最终文本中列出‘需要你决策’或‘请确认’后结束任务。不会阻碍当前交付的选择必须写成可选后续，不得伪装成错误或阻塞",
    "- 不得向用户输出当前 Agent 的工具清单、权限矩阵或‘缺少 write/bash/task’之类的内部能力说明。工具不可用时由运行时自动选择具备当前阶段能力的角色；只有系统权限确实需要用户批准时，才说明待批准的实际操作及影响",
    "- 给出方案时，引用具体文件路径和行号作为证据",
    "- 如果找不到相关证据，明确说未找到，不要编造",
    "- 修改代码前后都要说明改了什么文件、为什么改、证据是什么",
    "- 工具失败时先读取真实错误并尝试替代路径，不得第一次失败后直接放弃，也不得原样重复必然失败的调用",
    "- 工具结果包含 diagnostic 时，以其中的 kind、evidence 和 nextActions 作为恢复协议；先完成取证动作，再修改或重试",
    "- write/edit 返回 evidence-required 时必须按 requirements 补齐读取证据，禁止改用 shell 或其他写入路径绕过门禁",
    "- 如果没有现成工具且当前权限允许 bash/write，可在工作区的 .eval/tmp 中编写最小 Python/脚本工具完成转换或分析；执行前检查依赖，执行后清理临时文件",
    "- 自编脚本仍受当前执行范围、写入目录、命令审批和网络策略约束，禁止借脚本绕过权限",
    "",
    "## 文件管理与工作空间整洁（强制）",
    "- 输出文件必须放到合理位置：源代码放 src/ 或 Core/，头文件放 Inc/，文档放 docs/，配置放根目录",
    "- 禁止在工作空间根目录随意创建临时文件、测试文件、中间产物",
    "- 生成的新文件必须遵循项目已有的目录结构，不要凭空自创目录",
    "- 编译产物（.o/.hex/.bin/.elf）已在 Makefile/CMake 中配置输出到 build/ 目录，禁止手动移动",
    "- 修改文件前确认文件是否已存在，避免创建重复文件或覆盖已有模块",
    "- 如果一个目录下文件超过 10 个，考虑按功能拆分子目录",
    "- 任务完成后，不要遗留无用的临时文件、中间文件、调试输出文件",
  )

  // 工作流上下文（由 orchestrator 检测到预定义工作流时注入到 system prompt）
  if (workflowContext) {
    parts.push("", workflowContext)
  }

  // Plan Mode is a transient planning phase. Runtime owns the transition to execution.
  if (scope === "plan-mode") {
    parts.push(
      "",
      "## 计划模式（当前已开启）",
      "- **必须先调用 `plan` 工具提交执行计划；阶段切换由运行时负责，本阶段不能自行修改文件或执行命令**",
      "- **工作流程**：",
      "  1. 分析用户需求，构思执行方案",
      "  2. 调用 `plan` 工具，传入 title（计划标题）和 content（Markdown 格式的详细计划，含现状分析、目标、步骤）",
      "  3. plan 提交后立即结束规划阶段。自动规划会恢复用户原执行范围并继续；显式仅规划请求会等待用户审批",
      "  4. 进入执行阶段后，调用 `todowrite` 创建结构化任务清单（所有任务 status=\"pending\"，根据重要性标注 priority；需要委派时由你按语义分析显式填写已注册角色 assignee，运行时不会按关键词猜测）",
      "  5. 逐步执行。**每开始一个任务前，先调用 `todowrite` 将该任务 status 改为 \"in_progress\"**",
      "  6. **每完成一个任务，立即调用 `todowrite` 将该任务 status 改为 \"completed\"**",
      "  7. 所有任务完成后，输出总结",
      "- **关键规则**：",
      "  - `plan` 工具的 content 字段用 Markdown 编写，包含清晰的结构（现状、目标、步骤）",
      "  - 当存在多个可选方案时，在 plan 工具中传入 `options` 数组供用户选择，每项含 `label`（标题）和 `description`（描述）",
      "  - 每次调用 `todowrite` 必须传入**完整的 todos 数组**（工具是替换模式，不是增量更新）",
      "  - 任务状态变更必须**实时**：开始即 in_progress，完成即 completed，不要批量更新",
      "  - 如果用户修改了计划，重新调用 `plan` 提交修改后的计划",
      "  - 计划阶段只做分析，不能调用 compile/bash；执行阶段会按原执行范围、Agent 能力和系统策略重新计算权限。不要把本阶段只读描述成永久没有命令行能力",
      "- 计划示例：",
      '  ```',
      '  plan({',
      '    title: "编译子系统重构",',
      '    content: "## 现状问题\\n- compile 工具不读配置\\n\\n## 目标\\n- 自动读取 .eval/project.toml\\n\\n## 步骤\\n1. 新增 getChipCompilerFlags\\n2. 重构 compile 工具\\n3. 验证"  ',
      '  })',
      '  ```',
    )
  }

  // 自动编辑模式
  if (scope === "auto-edit") {
    parts.push(
      "",
      "## 自动编辑模式",
      "- 工作区文件创建、编辑、移动可直接执行，无需逐次询问",
      "- 终端、网络和硬件操作必须分别遵守用户配置的工具策略：允许则执行、询问则发起可交互审批、禁止才拒绝",
      "- 某项权限受限时继续使用当前已授权工具完成其余工作，不得把整个任务判定为不可执行",
    )
  }

  // 变更前确认模式
  if (scope === "confirm-changes") {
    parts.push(
      "",
      "## 变更前确认模式",
      "- 工作区写入前发起可交互审批并等待用户决定，不要只输出命令或文字让用户手动代办",
      "- 读取操作无需确认",
      "- 终端、网络和硬件操作分别遵守用户配置的工具策略；允许的职责继续执行，禁止项只限制对应能力",
    )
  }

  if (scope === "full-access") {
    parts.push(
      "",
      "## 完全访问模式",
      "- 对用户已允许或设为询问的能力自动执行，不逐次确认",
      "- 系统或项目策略明确设为禁止的能力仍不可绕过；遇到禁止项时继续完成其他已授权工作",
    )
  }

  // 可用技能目录
  if (skills.length > 0) {
    parts.push(
      "",
      "## 可用技能（使用 skill 工具加载完整指令）",
      ...skills.map((s) => `- **${s.name}**: ${s.description}`),
    )
  }

  // ── 项目配置（从 .eval/project.toml 加载）──
  const pjCfg = loadProjectConfig(workingDir)
  // 只有当配置不同于默认值时才注入（避免对未初始化项目注入无意义的默认值）
  const hasCustomConfig = hasConfiguredProjectTarget(pjCfg)
  if (hasCustomConfig) {
    const cfgLines: string[] = [
      `- 芯片: ${pjCfg.project.chip} (${pjCfg.project.chip_family} 系列)`,
      `- 工具链: ${pjCfg.build.toolchain} (${pjCfg.build.build_system})`,
      `- 调试器: ${pjCfg.debug.programmer} (${pjCfg.debug.target_cfg})`,
    ]
    if (pjCfg.build.c_flags) cfgLines.push(`- 编译选项: ${pjCfg.build.c_flags}`)
    if (pjCfg.debug.serial_port) cfgLines.push(`- 串口: ${pjCfg.debug.serial_port} @ ${pjCfg.debug.serial_baud ?? 115200}`)
    if (pjCfg.rtos?.type) cfgLines.push(`- RTOS: ${pjCfg.rtos.type}${pjCfg.rtos.config ? ` (${pjCfg.rtos.config})` : ""}`)
    parts.push("", "## 项目配置", ...cfgLines)
  }

  // ── 项目规则（从 .eval/rules.md 加载）──
  const rulesPath = join(workingDir, ".eval", "rules.md")
  if (existsSync(rulesPath)) {
    try {
      const rulesContent = readFileSync(rulesPath, "utf-8").trim()
      if (rulesContent) {
        parts.push("", "## 项目规则（来自 .eval/rules.md）", rulesContent)
      }
    } catch { /* 文件不可读，跳过 */ }
  }

  parts.push(
    "",
    "## 回复风格（强制）",
    `- 不要寒暄、不要自我介绍、不要说"你好我是XXX"之类的话`,
    "- 不要复述或总结用户的问题",
    "- 不要输出前言、过渡段、收尾客套话",
    "- 第一行直接给出方案 / 答案 / 行动项",
    "- 如需澄清问题，一次列出，不要用大段话铺垫",
  )
  return parts.join("\n")
}
