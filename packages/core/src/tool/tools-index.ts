// ─── 原理图工具 ───
export { schematicReadTool } from "./schematic/schematic-read.ts"
export { pinExtractTool } from "./schematic/pin-extract.ts"

// ─── 文件系统基础工具 ───
export { readTool, writeTool, editTool, moveTool, globTool, grepTool } from "./fs/index.ts"

// ─── 通用工具 ───
export { bashTool, webfetchTool, websearchTool, todowriteTool, planTool, questionTool, taskTool, delegateDagTool, skillTool } from "./general/index.ts"

// ─── 编译烧录 ───
export { compileTool } from "./hardware/compile.ts"
export { flashTool } from "./hardware/flash.ts"

// ─── 串口 ───
export { serialOpenTool, serialMonitorTool } from "./hardware/serial.ts"

// ─── 调试 ───
export { swdDebugTool } from "./hardware/swd.ts"

// ─── USB ───
export { usbTool } from "./hardware/usb.ts"

// ─── 项目/LVGL ───
export { projectInitTool } from "./hardware/project-init.ts"
export { chipAddTool } from "./hardware/chip-add.ts"
export { lvglGenTool } from "./hardware/lvgl-gen.ts"
export { datasheetReadTool } from "./schematic/datasheet-read.ts"

// ─── 文档输出 ───
export { writeOfficeTool } from "./hardware/write-office.ts"

// ─── OCR ───
export { ocrImageTool } from "./hardware/ocr.ts"
export { communityTools } from "./community/index.ts"

// ─── 聚合导出 ───
import type { ToolDefinition } from "./types.ts"
import { schematicReadTool } from "./schematic/schematic-read.ts"
import { pinExtractTool } from "./schematic/pin-extract.ts"
import { datasheetReadTool } from "./schematic/datasheet-read.ts"
import { compileTool } from "./hardware/compile.ts"
import { flashTool } from "./hardware/flash.ts"
import { serialOpenTool, serialMonitorTool } from "./hardware/serial.ts"
import { swdDebugTool } from "./hardware/swd.ts"
import { usbTool } from "./hardware/usb.ts"
import { projectInitTool } from "./hardware/project-init.ts"
import { chipAddTool } from "./hardware/chip-add.ts"
import { lvglGenTool } from "./hardware/lvgl-gen.ts"
import { writeOfficeTool } from "./hardware/write-office.ts"
import { ocrImageTool } from "./hardware/ocr.ts"
import { readTool, writeTool, editTool, moveTool, globTool, grepTool } from "./fs/index.ts"
import { bashTool, webfetchTool, websearchTool, todowriteTool, planTool, questionTool, taskTool, delegateDagTool, skillTool } from "./general/index.ts"
import { communityTools } from "./community/index.ts"

/** 所有内置工具列表 */
export const EMBEDDED_TOOLS: ToolDefinition[] = [
  // 文件系统基础
  readTool, writeTool, editTool, moveTool, globTool, grepTool,
  // 通用
  bashTool, webfetchTool, websearchTool, todowriteTool, planTool, questionTool, taskTool, delegateDagTool, skillTool,
  // 原理图
  schematicReadTool,
  pinExtractTool,
  // 编译烧录
  compileTool,
  flashTool,
  // 串口
  serialOpenTool,
  serialMonitorTool,
  // 调试
  swdDebugTool,
  // USB
  usbTool,
  // 项目/LVGL
  projectInitTool,
  chipAddTool,
  lvglGenTool,
  datasheetReadTool,
  // 文档输出
  writeOfficeTool,
  // OCR
  ocrImageTool,
  // Eval Web 社区
  ...communityTools,
]
