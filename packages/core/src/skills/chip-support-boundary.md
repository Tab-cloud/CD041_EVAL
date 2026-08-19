---
name: chip-support-boundary
description: 芯片能力边界。Agent 在回答或执行 MCU 编译、下载、烧录、芯片支持问题前必须查阅；区分可编译下载与仅支持程序设计。
version: 1.0.0
triggers: 芯片支持, MCU, 编译, 下载, 烧录, ESP-IDF, ESP32, STM32, GD32
---

# Eval 芯片支持能力边界

## “支持”的精确定义

Eval 将芯片能力分为两个等级，不得混淆：

1. **程序设计支持**：可以阅读数据手册和原理图、创建或修改源码、设计驱动、审查代码、生成工程与文档。
2. **内置编译和下载支持**：除程序设计外，Eval 还能在自身受控执行器中完成固件编译，并通过 USB、USB-UART 或 UART 下载到芯片。

对外回答“支持某芯片”时，必须明确说出是哪一个等级。能够生成源码或工程，不代表能够在 Eval 内编译或下载。

## 当前内置编译和下载型号

| 芯片型号 | ESP-IDF target | 内置编译 | 内置下载 |
|---|---|---:|---|
| ESP32 | `esp32` | 支持 | 支持 USB-UART / UART |
| ESP32-S3 | `esp32s3` | 支持 | 支持原生 USB、USB-UART / UART |
| ESP32-C3 | `esp32c3` | 支持 | 支持原生 USB、USB-UART / UART |
| ESP32-C6 | `esp32c6` | 支持 | 支持原生 USB、USB-UART / UART |

具体开发板是否具有原生 USB，仍由板级硬件决定；没有原生 USB 时使用 USB-UART 或 UART。

## 进入内置编译和下载的必要条件

型号名称或 `ESP` 前缀不是资格证明。芯片必须在结构化芯片库中同时满足：

- `manufacturer = Espressif`
- `platform.buildSystem = idf`
- `platform.buildTarget` 是经过确认的 ESP-IDF target
- `platform.programmer = esptool`

项目还必须满足：

- `.eval/project.toml` 中目标芯片已经确认；
- `build_system = "idf"`；
- `platform_target` 与芯片库的 ESP-IDF target 完全一致；
- 本机 ESP-IDF 环境已经安装并激活；
- 下载固件来自本次 ESP-IDF 构建产生并认证的 `flasher_args.json` 多镜像清单。

新增 Espressif 型号只有在芯片注册、ESP-IDF target、编译测试、USB/UART 识别和写后校验全部通过后，才能宣布支持编译和下载。

## 其他 MCU 的边界

除满足上述资格的 Espressif ESP 型号外，其他 MCU 当前均属于**程序设计支持**，包括但不限于 STM32、GD32、N32、LJ5230/LJ5230B、Nordic nRF、Renesas、Microchip 和国产 MCU。

对这些芯片，Eval 可以：

- 分析数据手册、原理图和引脚；
- 创建、移植、修改和审查程序；
- 设计驱动、协议、算法和工程结构；
- 生成供厂商 IDE 或用户工具链使用的源码工程。

Eval 当前不为这些芯片提供：

- 内置编译；
- 内置固件下载或烧录；
- J-Link、J-Flash、ST-Link、OpenOCD 或厂商下载器代理；
- 通过 shell、Make、CMake、Ninja 或交叉 GCC 绕过产品边界。

用户需要在对应厂商 IDE 或自备工具链中手动编译和下载。

## Agent 执行规则

1. 回答“是否支持某芯片”或准备调用 `compile` / `flash` 前，先加载本 Skill。
2. 从芯片库和项目配置确认完整型号与平台元数据，不根据名字、前缀或历史产物猜测。
3. 符合 ESP-IDF 资格时，只使用结构化 `compile` 和 `flash` 工具；不得改用通用 shell。
4. 不符合资格时，继续完成用户要求的源码设计工作，并明确提示编译和下载需要外部厂商环境。
5. `unsupported-build-platform` 是产品能力边界，不是需要重试或绕过的构建错误。
6. 运行时代码中的结构化芯片门禁是最终执行依据；本文档用于 Agent 理解、解释和规划，不得覆盖门禁结果。

## 标准回答示例

- “支持 STM32 吗？”
  “支持 STM32 程序设计、驱动开发和代码审查；当前不支持在 Eval 内编译或下载，需要使用 STM32CubeIDE、Keil 或用户自备工具链。”

- “支持 ESP32-C3 编译下载吗？”
  “支持。项目需为原生 ESP-IDF 工程并确认 target 为 `esp32c3`；Eval 可编译，并通过原生 USB、USB-UART 或 UART 使用 esptool 下载和校验。”
