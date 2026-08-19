import type { ProjectConfig, ProjectTemplate } from "./types.ts"

/**
 * 项目管理器
 * 
 * 负责：模板注册、项目生成、目录结构创建、文件管理
 */
export class ProjectManager {
  private templates: Map<string, ProjectTemplate> = new Map()

  /**
   * 注册项目模板
   */
  registerTemplate(template: ProjectTemplate): void {
    this.templates.set(template.name, template)
  }

  /**
   * 获取模板
   */
  getTemplate(name: string): ProjectTemplate | undefined {
    return this.templates.get(name)
  }

  /**
   * 根据芯片系列查找适用的模板
   */
  findTemplates(chipFamily: string): ProjectTemplate[] {
    return Array.from(this.templates.values()).filter((t) => t.chipFamilies.includes(chipFamily))
  }

  /**
   * 生成项目文件列表
   * 
   * 执行变量替换：{{PROJECT_NAME}} {{CHIP}} {{CHIP_FAMILY}} {{TOOLCHAIN}}
   */
  generateFiles(config: ProjectConfig, template?: ProjectTemplate): ProjectTemplate["files"] {
    const tpl = template ?? this.findTemplates(config.chipFamily)[0]
    if (!tpl) {
      throw new Error(`找不到适用于 ${config.chipFamily} 的项目模板`)
    }

    const vars: Record<string, string> = {
      PROJECT_NAME: config.name,
      CHIP: config.chip,
      CHIP_FAMILY: config.chipFamily,
      TOOLCHAIN: config.toolchain,
      HAL: config.hal,
      RTOS: config.rtos ?? "none",
      BUILD_SYSTEM: config.buildSystem,
    }

    return tpl.files.map((file) => ({
      ...file,
      content: file.content.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`),
    }))
  }

  /**
   * 生成项目目录列表
   */
  generateDirectories(template?: ProjectTemplate): string[] {
    const tpl = template ?? Array.from(this.templates.values())[0]
    if (!tpl) return []

    // 基础目录
    const base = ["src", "inc", "drivers", "lib", "build", "docs", "tools"]
    return [...base, ...tpl.directories]
  }
}
