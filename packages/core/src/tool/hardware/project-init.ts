/**
 * project_init 工具 — 嵌入式项目初始化
 * 
 * 根据芯片型号和需求，从模板生成完整的嵌入式项目结构。
 */
import { defineTool } from "../define.ts"
import type { ToolResult } from "../types.ts"
import { findChip, listChipsByFamily, getChipCompilerFlags } from "../../knowledge/chips.ts"
import { join } from "node:path"
import { safePath } from "../helpers"
import { existsSync, readdirSync } from "node:fs"
import { saveProjectConfig } from "../../store/project-config.ts"

export const projectInitTool = defineTool({
  name: "project_init",
  description: `初始化嵌入式项目结构。

功能：
- Cortex-M 芯片生成供源码设计和厂商工具导入的最小裸机工程
- Espressif 芯片生成原生 ESP-IDF 工程
- 生成标准目录结构（src/inc/drivers/lib/build/docs/tools）
- 生成 CMakeLists.txt、启动代码和链接脚本
- 生成 main.c 与 pinmap.h 模板
- 生成 pinmap.h（引脚映射表）
- 生成 README.md（项目文档）
- 可选 FreeRTOS 集成

支持的芯片系列：
- STM32F1 (STM32F103C8/CB/VE 等)
- STM32F4 (STM32F407VE/ZG 等)
- STM32G0 (STM32G030F6/G070RB 等)
- GD32F3 (GD32F303CC/VE 等)
- ESP32 / ESP32-S3 / ESP32-C3 / ESP32-C6

编译边界：
- Eval 内置 compile 仅执行 ESP 系列的原生 ESP-IDF 工程
- 其他芯片仍可生成和编辑工程，但需使用厂商 IDE 或用户自备工具链手动编译

参数：
- projectName: 项目名称
- chipModel: MCU 芯片型号 (如 STM32F103C8T6)
- outputDir: 输出目录
- rtos: RTOS 选择 (none / freertos)
- addDrivers: 需要初始化的外设列表 (如 ["uart", "spi", "i2c"])`,

  permission: "project",
  parameters: {
    type: "object",
    properties: {
      projectName: { type: "string", description: "项目名称" },
      chipModel: { type: "string", description: "MCU 型号" },
      outputDir: { type: "string", description: "输出目录" },
      rtos: { type: "string", enum: ["none", "freertos"], description: "RTOS 选择" },
      addDrivers: { type: "array", items: { type: "string" }, description: "需要的外设驱动" },
    },
    required: ["projectName", "chipModel", "outputDir"],
  },

  contract: { effects: ["workspace-read", "workspace-write"], idempotency: "idempotent", cancellation: "unsupported", progress: { role: "mutation", targetParameters: ["outputDir"] } },

  async execute(params, ctx): Promise<ToolResult> {
    const projectName = params.projectName as string
    const chipModel = (params.chipModel as string).toUpperCase()
    const outputDir = params.outputDir as string
    const rtos = (params.rtos as string) ?? "none"
    const addDrivers = (params.addDrivers as string[]) ?? []

    if (rtos === "freertos") {
      return { success: false, error: "FreeRTOS 内核源码未随模板捆绑；请先用 none 创建工程，再显式添加已选定版本的 FreeRTOS 源码" }
    }

    // 校验项目名（防止目录穿越：projectName 同时作为目录名与 CMake project 名）
    if (!/^[A-Za-z0-9_-]+$/.test(projectName)) {
      return { success: false, error: `项目名只能包含字母、数字、下划线、短横线: ${projectName}` }
    }
    // 收容 outputDir 到工作目录内，防止越权写
    let projectRoot: string
    try {
      projectRoot = join(safePath(ctx.workingDir, outputDir), projectName)
    } catch {
      return { success: false, error: `输出目录越权: ${outputDir}` }
    }
    if (existsSync(projectRoot) && readdirSync(projectRoot).length > 0) {
      return { success: false, error: `目标目录非空，拒绝覆盖已有项目: ${projectRoot}` }
    }

    // 1. 查找芯片信息
    const chipInfo = findChip(chipModel)
    if (!chipInfo) {
      // 列出支持的芯片
      const supportedFamilies = ["STM32F1", "STM32F4", "STM32G0", "GD32F3", "ESP32", "ESP32-S3", "ESP32-C3", "ESP32-C6"]
      const suggestions: string[] = []
      for (const family of supportedFamilies) {
        const chips = listChipsByFamily(family)
        suggestions.push(`${family}: ${chips.map((c) => c.model).join(", ")}`)
      }
      return {
        success: false,
        error: `不支持的芯片型号: ${chipModel}。支持的芯片:\n${suggestions.join("\n")}`,
      }
    }
    if (chipInfo.manufacturer === "Espressif") {
      return initializeEspIdfProject({
        projectName,
        projectRoot,
        chipModel: chipInfo.model,
        chipFamily: chipInfo.family,
        addDrivers,
        target: chipInfo.platform?.buildTarget,
      })
    }
    if (!chipInfo.core.toLowerCase().startsWith("cortex-m")) {
      return { success: false, error: `当前最小裸机模板仅支持 Cortex-M，${chipInfo.model} 请使用厂商 SDK/构建系统初始化` }
    }

    // 2. 确定模板
    const templateName = rtos === "freertos" ? `${chipInfo.family.toLowerCase()}-freertos` : `${chipInfo.family.toLowerCase()}-hal`

    // 3. 生成目录结构
    const dirs = [
      `${projectRoot}`,
      `${projectRoot}/src`,
      `${projectRoot}/src/app`,
      `${projectRoot}/src/tasks`,
      `${projectRoot}/inc`,
      `${projectRoot}/drivers`,
      `${projectRoot}/lib`,
      `${projectRoot}/build`,
      `${projectRoot}/docs`,
      `${projectRoot}/tools`,
    ]

    const createdDirs: string[] = []
    for (const dir of dirs) {
      try {
        await Bun.write(`${dir}/.gitkeep`, "")
        createdDirs.push(dir)
      } catch (err) {
        return { success: false, error: `创建目录失败 ${dir}: ${err}` }
      }
    }

    // 4. 生成 CMakeLists.txt
    const cmakeContent = generateCMakeLists(projectName, chipInfo, rtos)
    await Bun.write(`${projectRoot}/CMakeLists.txt`, cmakeContent)

    // 5. 生成 main.c
    const mainContent = generateMainC(projectName, chipInfo, rtos)
    await Bun.write(`${projectRoot}/src/main.c`, mainContent)

    // 6. 生成 main.h
    await Bun.write(`${projectRoot}/inc/main.h`, generateMainH(chipInfo))

    // 7. 生成 pinmap.h
    await Bun.write(`${projectRoot}/inc/pinmap.h`, generatePinmapH(chipInfo))

    // 8. 生成启动代码与链接脚本
    await Bun.write(`${projectRoot}/src/startup.c`, generateStartupC())
    const linkerName = `${chipInfo.model.toLowerCase()}.ld`
    await Bun.write(`${projectRoot}/${linkerName}`, generateLinkerScript(chipInfo))

    // 9. 生成 README.md
    const readmeContent = generateReadme(projectName, chipInfo, rtos, addDrivers)
    await Bun.write(`${projectRoot}/README.md`, readmeContent)

    // 10. 生成 .gitignore
    await Bun.write(`${projectRoot}/.gitignore`, "build/\n*.o\n*.elf\n*.hex\n*.bin\n*.d\n*.map\n")
    saveProjectConfig(projectRoot, {
      project: {
        name: projectName,
        chip: chipInfo.model,
        chip_family: chipInfo.family,
        target_confirmed: true,
        target_evidence: "用户在 project_init 中显式指定",
      },
      build: { toolchain: getChipCompilerFlags(chipInfo).toolchain ?? "arm-none-eabi-", build_system: "cmake" },
      debug: { programmer: "", target_cfg: "" },
    })

    return {
      success: true,
      data: {
        projectName,
        outputDir: `${projectRoot}`,
        chip: chipInfo,
        rtos,
        template: templateName,
        drivers: addDrivers,
        directories: createdDirs,
        files: [
          "CMakeLists.txt",
          "src/main.c", "src/startup.c", "inc/main.h", "inc/pinmap.h",
          linkerName, ".eval/project.toml", "README.md", ".gitignore",
        ],
        nextSteps: [
          "1. 编辑 pinmap.h 填充实际引脚定义",
          "2. 在 src/main.c 中实现应用逻辑",
          "3. 在 drivers/ 中添加外设驱动文件",
          "4. 将工程导入芯片厂商 IDE，或在用户自备工具链中手动编译",
          "5. 使用芯片厂商提供的下载工具手动下载固件",
        ],
      },
    }
  },
})

// ─── 模板生成函数 ───

async function initializeEspIdfProject(input: {
  projectName: string
  projectRoot: string
  chipModel: string
  chipFamily: string
  addDrivers: string[]
  target?: string
}): Promise<ToolResult> {
  const target = input.target
  if (!target) return { success: false, error: `没有 ${input.chipModel} 对应的 ESP-IDF target` }
  const directories = [input.projectRoot, join(input.projectRoot, "main"), join(input.projectRoot, "components")]
  for (const directory of directories) await Bun.write(join(directory, ".gitkeep"), "")
  await Bun.write(join(input.projectRoot, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(${input.projectName})
`)
  await Bun.write(join(input.projectRoot, "main", "CMakeLists.txt"), `idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")
`)
  await Bun.write(join(input.projectRoot, "main", "main.c"), `#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

static const char *TAG = "${input.projectName}";

void app_main(void)
{
    ESP_LOGI(TAG, "running on ${input.chipModel}");
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
`)
  await Bun.write(join(input.projectRoot, "sdkconfig.defaults"), [
    `CONFIG_IDF_TARGET="${target}"`,
    "CONFIG_ESPTOOLPY_AFTER_HARD_RESET=y",
    "",
  ].join("\n"))
  await Bun.write(join(input.projectRoot, ".gitignore"), "build/\nsdkconfig\nsdkconfig.old\ndependencies.lock\nmanaged_components/\n")
  await Bun.write(join(input.projectRoot, "README.md"), `# ${input.projectName}

ESP-IDF project for **${input.chipModel}**.

## Build

\`\`\`powershell
idf.py set-target ${target}
idf.py build
\`\`\`

Eval loads ESP-IDF's certified \`flasher_args.json\` and uses esptool for UART or native USB Serial/JTAG download.
`)
  saveProjectConfig(input.projectRoot, {
    project: {
      name: input.projectName,
      chip: input.chipModel,
      chip_family: input.chipFamily,
      target_confirmed: true,
      target_evidence: "用户在 project_init 中显式指定",
    },
    build: {
      toolchain: "",
      build_system: "idf",
      build_dir: "build",
      platform_target: target,
    },
    debug: {
      programmer: "esptool",
      target_cfg: target,
      serial_baud: 460800,
    },
  })
  return {
    success: true,
    data: {
      projectName: input.projectName,
      outputDir: input.projectRoot,
      chip: input.chipModel,
      template: "esp-idf",
      drivers: input.addDrivers,
      directories,
      files: [
        "CMakeLists.txt",
        "main/CMakeLists.txt",
        "main/main.c",
        "sdkconfig.defaults",
        ".eval/project.toml",
        "README.md",
        ".gitignore",
      ],
      nextSteps: [
        "1. 安装并激活 ESP-IDF 环境",
        `2. 运行 idf.py set-target ${target}`,
        "3. 运行 idf.py build",
        "4. 在下载页选择 USB Serial/JTAG、USB CDC 或 UART 端口，识别芯片后下载",
      ],
    },
  }
}

function generateCMakeLists(name: string, chip: ReturnType<typeof findChip>, _rtos: string): string {
  if (!chip) return ""
  const cFlags = getChipCompilerFlags(chip)
  const cpuFlags = cFlags.full

  return `cmake_minimum_required(VERSION 3.20)
set(TOOLCHAIN_PREFIX arm-none-eabi-)
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR ${chip.core})
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
set(CMAKE_C_COMPILER \${TOOLCHAIN_PREFIX}gcc)
set(CMAKE_ASM_COMPILER \${TOOLCHAIN_PREFIX}gcc)
set(CMAKE_OBJCOPY \${TOOLCHAIN_PREFIX}objcopy)
set(CMAKE_SIZE \${TOOLCHAIN_PREFIX}size)
project(${name} C ASM)

set(CPU_FLAGS "${cpuFlags}")
separate_arguments(CPU_FLAGS)

include_directories(\${CMAKE_SOURCE_DIR}/inc \${CMAKE_SOURCE_DIR}/drivers)
file(GLOB_RECURSE SRC_FILES CONFIGURE_DEPENDS
    \${CMAKE_SOURCE_DIR}/src/*.c
    \${CMAKE_SOURCE_DIR}/src/*.s
    \${CMAKE_SOURCE_DIR}/drivers/*.c)
add_executable(\${PROJECT_NAME}.elf \${SRC_FILES})
target_compile_definitions(\${PROJECT_NAME}.elf PRIVATE ${chip.model} ${chip.family})
target_compile_options(\${PROJECT_NAME}.elf PRIVATE
    \${CPU_FLAGS} -Wall -Wextra -Os -g3 -ffunction-sections -fdata-sections -std=gnu11)
target_link_options(\${PROJECT_NAME}.elf PRIVATE
    \${CPU_FLAGS}
    -T\${CMAKE_SOURCE_DIR}/${chip.model.toLowerCase()}.ld
    -nostartfiles
    -Wl,--gc-sections,-Map=\${PROJECT_NAME}.map)
target_link_libraries(\${PROJECT_NAME}.elf gcc)
add_custom_command(TARGET \${PROJECT_NAME}.elf POST_BUILD
    COMMAND \${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:\${PROJECT_NAME}.elf> \${PROJECT_NAME}.hex
    COMMAND \${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:\${PROJECT_NAME}.elf> \${PROJECT_NAME}.bin
    COMMAND \${CMAKE_SIZE} $<TARGET_FILE:\${PROJECT_NAME}.elf>)
`
}

function generateMainC(projectName: string, chip: ReturnType<typeof findChip>, _rtos: string): string {
  if (!chip) return ""
  return `/**
 * @file    main.c
 * @brief   ${projectName} 最小裸机入口
 * @chip    ${chip.model} (${chip.core} @ ${chip.maxFreq})
 */
#include "main.h"

volatile uint32_t heartbeat_counter;

__attribute__((weak)) void platform_init(void) {}
__attribute__((weak)) void platform_idle(void) {}

int main(void) {
    platform_init();
    while (1) {
        heartbeat_counter++;
        platform_idle();
    }
}
`
}

function generateMainH(chip: ReturnType<typeof findChip>): string {
  if (!chip) return ""
  return `#ifndef __MAIN_H__
#define __MAIN_H__

#include <stdint.h>
#include <stdbool.h>

/* 芯片: ${chip.model} (${chip.core} @ ${chip.maxFreq}) */

void platform_init(void);
void platform_idle(void);

#endif /* __MAIN_H__ */
`
}

function generatePinmapH(chip: ReturnType<typeof findChip>): string {
  if (!chip) return ""
  return `/**
 * @file    pinmap.h
 * @brief   ${chip.model} 引脚映射表
 * @generated 由 project_init 生成
 */
#ifndef __PINMAP_H__
#define __PINMAP_H__

#include "main.h"

/* ═══ 芯片资源: GPIO=${chip.gpio} UART=${chip.uart} SPI=${chip.spi} I2C=${chip.i2c} ADC=${chip.adc.channels}ch/${chip.adc.bits}bit ═══ */

/* ─── 调试串口 (USART1) ─── */
#define DEBUG_UART_INSTANCE  1U
#define DEBUG_BAUD           115200U

/* 根据原理图和所选 HAL/CMSIS 包补充端口、引脚及复用功能。 */

#endif /* __PINMAP_H__ */
`
}

function generateStartupC(): string {
  return `#include <stdint.h>

extern uint32_t _estack;
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss;
int main(void);

void Reset_Handler(void);
void Default_Handler(void);
void NMI_Handler(void) __attribute__((weak, alias("Default_Handler")));
void HardFault_Handler(void) __attribute__((weak, alias("Default_Handler")));
void SVC_Handler(void) __attribute__((weak, alias("Default_Handler")));
void PendSV_Handler(void) __attribute__((weak, alias("Default_Handler")));
void SysTick_Handler(void) __attribute__((weak, alias("Default_Handler")));

__attribute__((used, section(".isr_vector")))
const uintptr_t vector_table[] = {
    (uintptr_t)&_estack,
    (uintptr_t)Reset_Handler,
    (uintptr_t)NMI_Handler,
    (uintptr_t)HardFault_Handler,
    0U, 0U, 0U, 0U, 0U, 0U, 0U,
    (uintptr_t)SVC_Handler,
    0U, 0U,
    (uintptr_t)PendSV_Handler,
    (uintptr_t)SysTick_Handler,
};

void Reset_Handler(void) {
    uint32_t *src = &_sidata;
    for (uint32_t *dst = &_sdata; dst < &_edata; ) *dst++ = *src++;
    for (uint32_t *dst = &_sbss; dst < &_ebss; ) *dst++ = 0U;
    (void)main();
    while (1) {}
}

void Default_Handler(void) {
    while (1) {}
}
`
}

function generateLinkerScript(chip: ReturnType<typeof findChip>): string {
  if (!chip) return ""
  return `ENTRY(Reset_Handler)

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = ${linkerLength(chip.flash)}
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = ${linkerLength(chip.sram)}
}

_estack = ORIGIN(RAM) + LENGTH(RAM);

SECTIONS
{
  .isr_vector : { KEEP(*(.isr_vector)) } > FLASH
  .text :
  {
    *(.text*)
    *(.rodata*)
    KEEP(*(.init))
    KEEP(*(.fini))
    . = ALIGN(4);
  } > FLASH

  .ARM.extab : { *(.ARM.extab*) } > FLASH
  .ARM.exidx : { *(.ARM.exidx*) } > FLASH

  _sidata = LOADADDR(.data);
  .data :
  {
    . = ALIGN(4);
    _sdata = .;
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } > RAM AT > FLASH

  .bss (NOLOAD) :
  {
    . = ALIGN(4);
    _sbss = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > RAM
}
`
}

function linkerLength(value: string): string {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB)$/i)
  if (!match) throw new Error(`无法解析存储容量: ${value}`)
  return `${match[1]}${match[2][0].toUpperCase()}`
}

function generateReadme(
  name: string,
  chip: ReturnType<typeof findChip>,
  rtos: string,
  drivers: string[],
): string {
  if (!chip) return ""
  return `# ${name}

> 芯片: ${chip.model} | 内核: ${chip.core} | ${chip.maxFreq} | Flash: ${chip.flash} | SRAM: ${chip.sram}
> ${rtos !== "none" ? `RTOS: ${rtos}` : ""}

## 构建与下载边界

Eval 为该非 ESP 芯片生成源码设计工程，但不执行内置编译或下载。请将工程导入芯片厂商
IDE，或使用你已经安装并确认兼容的工具链手动编译；固件下载同样使用厂商工具完成。

## 目录结构

| 目录 | 说明 |
|------|------|
| src/ | 应用代码 |
| inc/ | 头文件 |
| drivers/ | 外设驱动 (${drivers.length > 0 ? drivers.join(", ") : "待添加"}) |
| lib/ | 第三方库 |
| build/ | 编译输出 |
| docs/ | 文档 |
| tools/ | 辅助脚本 |

## 引脚分配

见 inc/pinmap.h。待原理图分析后更新。

`
}
