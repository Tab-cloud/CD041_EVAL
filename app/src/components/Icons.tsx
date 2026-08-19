/**
 * 图标组件库 — 基于 Lucide Icons (MIT License) SVG path
 * https://lucide.dev
 */
import type { SVGProps } from "react"

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function icon(path: string, viewBox = "0 0 24 24") {
  return ({ size = 16, ...props }: IconProps) => (
    <svg
      width={size} height={size} viewBox={viewBox}
      fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={path} />
    </svg>
  )
}

function iconMulti(paths: string[], viewBox = "0 0 24 24") {
  return ({ size = 16, ...props }: IconProps) => (
    <svg
      width={size} height={size} viewBox={viewBox}
      fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}

// ─── 通用 ───
export const CpuIcon          = icon("M5 5h14v14H5z M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M20 9h3 M20 14h3 M1 9h3 M1 14h3")
export const SettingsIcon     = icon("M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z")

export const SunIcon          = icon("M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M6.34 17.66l-1.41 1.41 M19.07 4.93l-1.41 1.41 M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z")
export const MoonIcon         = icon("M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z")
export const PlusIcon         = icon("M12 5v14 M5 12h14")
export const XIcon            = icon("M18 6 6 18 M6 6l12 12")
export const SearchIcon       = icon("M21 21l-4.3-4.3 M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z")
export const CheckIcon        = icon("M20 6 9 17l-5-5")
export const CopyIcon         = iconMulti(["M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"])
export const PencilIcon       = icon("M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.36a.5.5 0 0 0 .62.62L7 20.66a2 2 0 0 0 .83-.5z M15 5l4 4")
export const CircleIcon       = icon("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z")
export const ChevronDownIcon  = icon("M6 9l6 6 6-6")
export const ChevronRightIcon = icon("M9 18l6-6-6-6")
export const ChevronLeftIcon  = icon("M15 18l-6-6 6-6")
export const ExternalLinkIcon = icon("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14 21 3")
export const FilterIcon        = icon("M22 3H2l8 9.5V19l4 2v-8.5L22 3z")
export const SaveIcon          = icon("M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8")
export const SplitIcon         = icon("M3 3h7v18H3z M14 3h7v18h-7z")
export const MoreHorizontalIcon = icon("M5 12h.01 M12 12h.01 M19 12h.01")
export const PlayIcon          = icon("M6 3l14 9-14 9V3z")
export const PauseIcon         = icon("M8 5v14 M16 5v14")
export const GitBranchIcon     = icon("M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 9a9 9 0 0 1-9 9")
export const ClockIcon         = icon("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2")
export const BellIcon          = icon("M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4")
export const WifiIcon          = icon("M5 12.6a10 10 0 0 1 14 0 M8.5 16.1a5 5 0 0 1 7 0 M12 20h.01 M2 9a15 15 0 0 1 20 0")

// ─── 文件/项目 ───
export const FolderIcon       = icon("M20 6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6l2 2h8z")
export const FolderOpenIcon   = icon("M6.2 20a2 2 0 0 1-2-1.8L2.2 6.2A2 2 0 0 1 4 4h5.2a2 2 0 0 1 1.4.6L12.8 7h7a2 2 0 0 1 2 2v1 M6.2 20H18a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4.8a2 2 0 0 1-1.4-.6L10.2 7H4.2A2 2 0 0 0 2.2 9.8L4 18.2A2 2 0 0 0 6 20")
export const FileIcon         = icon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6")
export const FileCodeIcon     = icon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M10 13l-2 2 2 2 M14 17l2-2-2-2")
export const RefreshCwIcon    = icon("M21 12a9 9 0 1 1-9-9c2.5 0 4.2 1 5.7 2.5 M21 3v5h-5")
export const ThumbsUpIcon     = icon("M7 10v12 M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.8L10 3.6A2 2 0 0 1 11.8 2a3 3 0 0 1 3.2 3.9z")
export const ThumbsDownIcon   = icon("M17 14V2 M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-7A2 2 0 0 1 6.5 3H20a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2.8L14 20.4A2 2 0 0 1 12.2 22 3 3 0 0 1 9 18.1z")
export const ShareIcon        = icon("M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7 M16 6l-4-4-4 4 M12 2v14")

// ─── 聊天/消息 ───
export const MessageSquareIcon = icon("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")
export const SendIcon         = icon("M22 2 11 13 M22 2 15 22l-4-9-9-4z M22 2 11 13")
export const StopIcon         = icon("M5 5h14v14H5z")
export const PaperclipIcon    = icon("M21.4 11.6l-9.1 9.1a6 6 0 0 1-8.5-8.5l9.1-9.1a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5")
export const UserIcon         = icon("M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z")
export const BotIcon          = icon("M12 8V4H8 M12 8h4 M12 8v2 M4 10a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2l2 4h8l2-4h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H4z M9 14h.01 M15 14h.01")

// ─── 面板/工具 ───
export const TerminalIcon     = icon("M4 17l6-6-6-6 M12 19h8")
export const MonitorIcon      = icon("M20 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M8 21h8 M12 17v4")
export const BugIcon          = icon("M10 4h4 M12 4v4 M8.5 2.5 11.5 8 M15.5 2.5 12.5 8 M6 13v-2a6 6 0 0 1 12 0v2 M8 13h8 M8 17a4 4 0 0 0 8 0v-4H8v4z")
export const WrenchIcon       = icon("M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z")
export const Trash2Icon       = icon("M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M10 11v6 M14 11v6")
export const DownloadIcon     = icon("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3")
export const UploadIcon       = icon("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12")
export const ActivityIcon     = icon("M22 12h-4l-3 9L9 3l-3 9H2")
export const DatabaseIcon     = icon("M12 2C7 2 3 3.8 3 6s4 4 9 4 9-1.8 9-4-4-4-9-4z M3 6v6c0 2.2 4 4 9 4s9-1.8 9-4V6 M3 12v6c0 2.2 4 4 9 4s9-1.8 9-4v-6")
export const Building2Icon    = icon("M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18 M2 22h20 M10 6h4 M10 10h4 M10 14h4 M10 18h4")
export const CoffeeIcon       = icon("M17 8h1a4 4 0 0 1 0 8h-1 M3 8h14v7a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8z M6 2v3 M10 2v3 M14 2v3")
export const PrinterIcon      = icon("M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z")
export const MoveIcon         = icon("M5 9 2 12l3 3 M9 5l3-3 3 3 M15 19l-3 3-3-3 M19 9l3 3-3 3 M2 12h20 M12 2v20")
export const ShirtIcon        = icon("M8 3 4 5 2 10l4 2v9h12v-9l4-2-2-5-4-2a4 4 0 0 1-8 0z")
export const BarChartIcon     = icon("M4 20V10 M10 20V4 M16 20v-7 M22 20H2")
export const Maximize2Icon    = icon("M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7")
export const Minimize2Icon    = icon("M4 14h6v6 M20 10h-6V4 M14 10l7-7 M3 21l7-7")
export const PaintbrushIcon   = icon("M14.6 4.4 19.6 9.4 M13.2 5.8l5 5 M14 4l6 6-8.5 8.5a4.2 4.2 0 0 1-6-6L14 4z M7 17c-1 3-3 4-5 3 2-1 2-3 3-5")
export const PackageIcon      = icon("M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z M3.3 7 12 12l8.7-5 M12 22V12")
export const LockIcon         = icon("M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4")
export const BookOpenIcon     = icon("M2 4h6a4 4 0 0 1 4 4v12a4 4 0 0 0-4-4H2z M22 4h-6a4 4 0 0 0-4 4v12a4 4 0 0 1 4-4h6z")
export const ShoppingBagIcon  = icon("M6 8V6a6 6 0 0 1 12 0v2 M3 8h18l-1 13H4L3 8z M9 11v1 M15 11v1")
export const HeartIcon        = icon("M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z")
export const SparklesIcon     = icon("M12 3l1.3 3.7L17 8l-3.7 1.3L12 13l-1.3-3.7L7 8l3.7-1.3L12 3z M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z M5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14z")
export const TrophyIcon       = icon("M8 21h8 M12 17v4 M7 4h10v5a5 5 0 0 1-10 0V4z M7 6H4v2a4 4 0 0 0 4 4 M17 6h3v2a4 4 0 0 1-4 4")

// ─── 嵌入式专用 ───
export const CircuitBoardIcon = iconMulti([
  "M18.2 10.3a2 2 0 0 0-1.4-2l-1.1-.3L14.5 5a2 2 0 0 0-2.4-1L8.4 5.2a2 2 0 0 0-1.1 2.5l.5 1.1",
  "M15.7 18.5a2 2 0 0 0 1.4-2.1l-.3-1.1L18 14a2 2 0 0 0 1-2.5l-1.2-3.7a2 2 0 0 0-2.6-1.1L11 8.3",
  "M2.4 14.5a2 2 0 0 0 2.5 1l3.7-1.2a2 2 0 0 0 1.1-2.6l-.5-1.1L10 9.5a2 2 0 0 0-2.4 1L5.5 14a2 2 0 0 0 .8 2.5z",
  "M12 12l.01.01"
])
export const CpuChipIcon      = iconMulti([
  "M9 2v2 M15 2v2 M9 20v2 M15 20v2 M2 9h2 M2 15h2 M20 9h2 M20 15h2",
  "M6 6h12v12H6z M10 10h4v4h-4z"
])
export const ZapIcon          = icon("M13 2 3 14h9l-1 8 10-12h-9l1-8z")
export const HammerIcon       = icon("M15 12l-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9 M17.6 6.4a2 2 0 0 1 0 2.8l-1.4 1.4a2 2 0 0 1-2.8 0l-1.4-1.4a2 2 0 0 1 0-2.8l1.4-1.4a2 2 0 0 1 2.8 0z M17.6 6.4 21 3")
export const UsbIcon          = icon("M12 22v-5 M10 17l-7-3 7-3 M19 11l-7 3 7 3 M12 12v-1 M11 7l-1-3 1-3h2l1 3-1 3z")

// ─── 状态/提示 ───
export const CheckCircleIcon  = icon("M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z M16 8l-6 6-3-3")
export const AlertCircleIcon  = icon("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v4 M12 16h.01")
export const InfoIcon         = icon("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01")
export const LightbulbIcon    = icon("M15 14a3 3 0 1 0-6 0v4h6v-4z M9 18h6 M10 22h4")

// ─── 能力标签 ───
export const EyeIcon          = icon("M21.3 12.2c-.6-.9-3.3-5.2-9.3-5.2S3.3 11.3 2.7 12.2a1 1 0 0 0 0 1.6c.6.9 3.3 5.2 9.3 5.2s8.7-4.3 9.3-5.2a1 1 0 0 0 0-1.6z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z")
export const BrainIcon        = icon("M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z")
export const Code2Icon        = icon("M16 18l6-6-6-6 M8 6l-6 6 6 6")

// 别名导出
export const SpinnerIcon = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
    <path d="M21 12a9 9 0 1 1-6.2-8.7" strokeLinecap="round">
      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
    </path>
  </svg>
)

// ─── 范围模式图标 ───
export const HandIcon          = icon("M18 11V6a2 2 0 0 0-4 0v5 M14 10V4a2 2 0 0 0-4 0v6 M10 10.5V6a2 2 0 0 0-4 0v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.8-2.6L3 15a2.7 2.7 0 0 1 4-3.5L9 14")
export const ShieldIcon        = icon("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z")
export const ListChecksIcon    = icon("M3 6h13 M3 12h13 M3 18h13 M16 6l2 2 4-4 M16 12l2 2 4-4 M16 18l2 2 4-4")

// ─── 文件类型图标 ───
export const FileImageIcon     = icon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M9 13l-2 4h10l-4-6-2 2z")
export const FileTextIcon      = icon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8")
export const FilePdfIcon       = icon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M10 12v5 M10 12h2a2 2 0 0 1 0 4h-2 M16 12h-1v5 M15 14h1")
export const FileDocxIcon      = icon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 10l3 4-3 4 M16 15v2 M16 10v2")
export const FileXlsxIcon      = icon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 14h8 M8 18h8 M8 10h8")
export const FilePptxIcon      = icon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 14l-3 3 3 3")

// ─── 归档（火焰） ───
export const ArchiveIcon       = icon("M4 20h16a2 2 0 0 0 2-2V8l-6-4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z M10 12h4 M12 10v4")
export const FlameIcon         = icon("M8.6 21c-2.5-2-4.6-5.2-4.6-9 0-7 8-14 8-14s8 7 8 14c0 3.8-2.1 7-4.6 9")
export const GaugeIcon         = icon("M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z")
export const FolderOpenIconFlat = icon("M6 14H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M6 14a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-1 M6 14l1.5-5h11L20 14")
export const RotateCcwIcon     = icon("M1 4v6h6 M3.5 15a9 9 0 1 0 2.1-9.4L1 10")
