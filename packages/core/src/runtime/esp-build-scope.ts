import { findChip, type ChipInfo } from "../knowledge/chips.ts"

export const ESP_ONLY_BUILD_MESSAGE =
  "Eval 内置编译当前仅支持 Espressif ESP 系列芯片的原生 ESP-IDF 工程。其他芯片仍可进行源码编写、驱动设计和代码审查，但请在对应厂商 IDE 或用户自备工具链中手动编译。"

export interface EspBuildTarget {
  chip: ChipInfo
  buildTarget: string
}

/**
 * The product boundary is metadata-driven rather than model-name-driven.
 * Built-in and project-maintained chips must explicitly declare the
 * Espressif/ESP-IDF/esptool platform contract before they can enter execution.
 */
export function resolveEspBuildTarget(
  chipModel: string,
  projectRoot?: string,
): EspBuildTarget {
  const chip = findChip(chipModel, projectRoot)
  if (!chip
    || chip.manufacturer?.trim().toLowerCase() !== "espressif"
    || chip.platform?.buildSystem !== "idf"
    || chip.platform.programmer !== "esptool"
    || !validIdfTarget(chip.platform.buildTarget)) {
    throw new Error(ESP_ONLY_BUILD_MESSAGE)
  }
  return { chip, buildTarget: chip.platform.buildTarget }
}

export function assertEspBuildContract(input: {
  projectRoot: string
  chipModel?: string
  buildSystem: string
  platformTarget?: string
}): EspBuildTarget {
  if (!input.chipModel?.trim()) {
    throw new Error("请先确认当前 ESP 项目的完整芯片型号，再执行编译。")
  }
  const target = resolveEspBuildTarget(input.chipModel, input.projectRoot)
  if (input.buildSystem !== "idf") {
    throw new Error(`${ESP_ONLY_BUILD_MESSAGE} 当前项目必须声明 build_system="idf"。`)
  }
  if (!input.platformTarget?.trim()) {
    throw new Error(`ESP 项目缺少 platform_target；该芯片应使用 ${target.buildTarget}。`)
  }
  if (input.platformTarget.trim().toLowerCase() !== target.buildTarget.toLowerCase()) {
    throw new Error(
      `ESP-IDF target 与已确认芯片不一致：项目为 ${input.platformTarget}，芯片要求 ${target.buildTarget}。`,
    )
  }
  return target
}

function validIdfTarget(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,31}$/i.test(value.trim())
}
