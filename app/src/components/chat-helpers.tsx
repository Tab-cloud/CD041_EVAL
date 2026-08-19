import type { ReactNode } from "react"
import { HandIcon, ShieldIcon, ListChecksIcon, TerminalIcon, SearchIcon, Trash2Icon, FolderIcon, CpuIcon, SettingsIcon } from "./Icons"

// ══════════════════════════════════════════════════
// 类型
// ══════════════════════════════════════════════════

export interface Attachment {
  name: string
  path: string
  size: number
  mime: string
  kind: "image" | "text" | "binary"
  dataUrl?: string  // 图片：data:image/...;base64,...
  content?: string  // 文本：完整内容
  dataBase64?: string // PDF/Office/其他二进制：实际文件字节，不依赖本机路径
  uploadId?: string // 已安全暂存到本地 Agent；任务提交仅携带此内容引用
}

export type ScopeMode = "confirm-changes" | "auto-edit" | "plan-mode" | "full-access"
export type EffortMode = "on" | "off"

// ══════════════════════════════════════════════════
// 常量
// ══════════════════════════════════════════════════

/** 文本类扩展名白名单 */
export const TEXT_EXTS = new Set([
  "c","h","cpp","cc","hpp","cxx","hh","m","mm",
  "py","pyi","pyx","pyw",
  "js","jsx","mjs","cjs","ts","tsx","mts","cts",
  "rs","go","java","kt","kts","swift","rb","php","pl","pm","lua","sh","bash","zsh","fish",
  "html","htm","css","scss","sass","less","styl",
  "json","jsonc","json5","yaml","yml","toml","ini","cfg","conf",
  "xml","svg","md","markdown","txt","rst","adoc","tex",
  "sql","graphql","gql","prisma","proto",
  "env","gitignore","dockerignore","editorconfig",
  "csv","tsv","log","diff","patch",
])

export const SCOPE_OPTIONS: Array<{ id: ScopeMode; icon: ReactNode; label: string; desc: string; warn?: boolean }> = [
  { id: "confirm-changes", icon: <HandIcon size={14} />, label: "变更前确认", desc: "读取直接执行，写入前确认；其他能力按工具策略。" },
  { id: "auto-edit", icon: <ShieldIcon size={14} />, label: "自动编辑文件", desc: "文件自动修改；终端、网络、硬件按工具策略。" },
  { id: "plan-mode", icon: <ListChecksIcon size={14} />, label: "计划模式", desc: "只读分析并生成计划，不执行变更。" },
  { id: "full-access", icon: <ShieldIcon size={14} />, label: "完全访问", desc: "自动执行未被系统或项目策略禁止的操作。", warn: true },
]

export const EFFORT_OPTIONS: Array<{ id: EffortMode; label: string }> = [
  { id: "on", label: "开启" },
  { id: "off", label: "关闭" },
]

/** 工具名称 → 中文标签 */
export const TOOL_LABELS: Record<string, string> = {
  read: "读取中", write: "写入中", edit: "编辑中", move: "移动文件中", glob: "搜索文件中", grep: "搜索内容中",
  bash: "执行命令中", webfetch: "获取网页中", websearch: "搜索中", todowrite: "更新任务中",
  skill: "加载技能中", ocr_image: "识别图片中", schematic_read: "读取原理图中",
  pin_extract: "提取引脚中", compile: "编译中", flash: "烧录中",
  serial_open: "打开串口中", serial_monitor: "监听串口中", swd_debug: "调试中",
  question: "等待用户输入", write_office: "生成文档中",
  schematic_write: "写入原理图中", openocd: "调试中", jlink: "调试中",
}

// ══════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════

export function detectKind(name: string, mime: string): "image" | "text" | "binary" {
  if (mime.startsWith("image/")) return "image"
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (TEXT_EXTS.has(ext)) return "text"
  return "binary"
}

export function toolStatusLabel(name: string): string {
  return TOOL_LABELS[name] ?? `${name}`
}

export function toolTargetPath(input?: Record<string, unknown>): string {
  if (!input) return "..."
  const p = input.path ?? input.pattern ?? input.command ?? input.url ?? input.query ?? ""
  if (typeof p !== "string" || !p) return "..."
  // 只取文件名或末尾 2 段路径
  const parts = p.split(/[/\\]/)
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p.slice(0, 40)
}

/** 格式化文件大小 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

// ══════════════════════════════════════════════════
// Slash 命令
// ══════════════════════════════════════════════════

export interface SlashCommand {
  key: string
  label: string
  desc: string
  icon: ReactNode
  prompt?: string  // 替换用户输入的命令提示词
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { key: "/init",      label: "初始化项目",   desc: "分析目录，识别原理图+芯片手册，初始化项目结构", icon: <CpuIcon size={14} />,
    prompt: "请分析当前工作目录，执行以下步骤：\n1. 使用 glob 搜索所有原理图文件（PDF/PNG/JPEG），对每个原理图调用 schematic_read 分析\n2. 使用 glob 搜索所有芯片手册/数据手册文件（PDF），逐一读取并提取：芯片型号、主要参数、引脚定义、外设列表等关键信息，整理为结构化摘要\n3. 分析项目结构，识别芯片型号和开发环境\n4. 输出完整的项目初始化报告，包括：原理图分析摘要、芯片参数汇总、项目结构建议" },
  { key: "/review",    label: "审查变更",     desc: "审查当前工作区所有改动，输出审查报告",    icon: <SearchIcon size={14} />,
    prompt: "请审查当前工作区所有改动。检查代码质量、潜在 bug、编译风险、内存泄漏、中断安全等嵌入式常见问题，输出审查报告。" },
  { key: "/compact",   label: "压缩上下文",   desc: "总结对话生成摘要，压缩上下文释放空间",    icon: <TerminalIcon size={14} />,
    prompt: "请为当前对话生成一份结构化摘要，包含：1) 用户需求 2) 已完成操作 3) 项目状态（芯片型号、开发环境、编译状态）4) 待解决问题。" },
  { key: "/commit",    label: "提交改动",     desc: "生成规范的 git commit 并推送",           icon: <FolderIcon size={14} />,
    prompt: "请审查所有改动，生成规范的 git commit 信息并提交。信息要求：1) 前缀（docs/fix/feat/refactor） 2) 从用户角度说明为什么改 3) 具体到哪些文件/模块。不要用模糊描述。如果有冲突不要修复，通知我。" },
  { key: "/learn",     label: "沉淀经验",     desc: "从会话中提取经验写入 AGENTS.md",         icon: <SettingsIcon size={14} />,
    prompt: "分析本次会话，提取非显而易见的经验教训写入 AGENTS.md 文件中。包括：1) 隐藏的文件/模块关系 2) 编译器/链接器/烧录工具的特殊配置 3) 芯片硬件限制和工作区 4) 调试突破点。已存在的内容不要重复。保持每条 1-3 行。" },
  { key: "/changelog", label: "生成变更日志", desc: "从 git log 生成 CHANGELOG",               icon: <TerminalIcon size={14} />,
    prompt: "请从 git log 中提取自上一个版本以来的所有变更，生成结构化的 CHANGELOG.md。按 feat/fix/refactor/docs 分类，标注每个变更影响的功能模块。" },
  { key: "/translate", label: "翻译文档",     desc: "翻译嵌入式技术文档（中↔英）",            icon: <SettingsIcon size={14} />,
    prompt: "请将以下内容翻译。如果是英文→中文，保持专业术语的准确性（寄存器名、引脚名、协议名保留原文）。如果是中文→英文，确保嵌入式领域术语正确。" },
  { key: "/clear",     label: "清空对话",     desc: "清空当前会话，重新开始",                  icon: <Trash2Icon size={14} /> },
  { key: "/help",      label: "帮助",         desc: "显示所有可用命令和快捷键",                icon: <SettingsIcon size={14} /> },
]
