/** 项目配置 */
export interface ProjectConfig {
  /** 项目名称 */
  name: string
  /** 芯片型号 (如 STM32F103C8T6) */
  chip: string
  /** 芯片系列 (如 STM32F1) */
  chipFamily: string
  /** 工具链 (arm-none-eabi-gcc) */
  toolchain: string
  /** 构建系统 (cmake / makefile) */
  buildSystem: "cmake" | "makefile"
  /** HAL 库 (stm32-hal / gd32-hal / bare-metal) */
  hal: string
  /** RTOS (none / freertos / rtthread) */
  rtos?: string
  /** 项目根目录 */
  rootDir: string
}

/** 项目模板 */
export interface ProjectTemplate {
  /** 模板名称 */
  name: string
  /** 描述 */
  description: string
  /** 适用芯片系列 */
  chipFamilies: string[]
  /** 文件列表 (相对于项目根目录) */
  files: ProjectTemplateFile[]
  /** 附加的目录 */
  directories: string[]
}

/** 模板文件 */
export interface ProjectTemplateFile {
  /** 文件路径 */
  path: string
  /** 文件内容 (支持变量替换: {{PROJECT_NAME}}, {{CHIP}}, 等) */
  content: string
  /** 是否可执行 (脚本) */
  executable?: boolean
}
