# 编译流水线架构

## 1. 目标

### 1.1 当前产品边界

Eval 内置编译从 2026-07-29 起只执行芯片库明确声明
`manufacturer=Espressif`、`platform.buildSystem=idf`、`platform.programmer=esptool`
的原生 ESP-IDF 工程。支持资格来自结构化芯片元数据和精确 `platform_target`，不使用型号前缀、
模型文本或构建日志猜测。

非 ESP 芯片仍完整支持源码编写、驱动设计、原理图/数据手册分析、代码审查、工程维护和项目
初始化。Eval 不执行这些工程的内置编译，也不允许 Agent 用 `bash` 调用 Make/CMake/Ninja/
交叉 GCC 绕过边界；用户可在厂商 IDE 或自备工具链中手动编译和下载。

Eval 的内置固件下载也收敛到 ESP：只接受本次 ESP-IDF 构建清单认证的多 BIN 镜像，通过
USB Serial/JTAG、USB CDC 或 UART 连接后由 esptool 识别真实芯片、写入并校验。J-Link、
J-Flash、任意 HEX、模型提供的地址和非 ESP 下载流程不属于内置能力。

编译功能必须回答三个彼此独立的问题：

1. 构建进程是否成功结束。
2. 哪些固件产物由本次输入产生，或可由同一输入安全复用。
3. 哪个产物满足当前目标设备的下载条件。

旧实现把三者合并为“命令退出码为 0”，因此会出现错误芯片仍显示成功、历史 HEX 被误选、下载目标与编译目标脱节等问题。新架构以不可变构建请求和可审计清单为边界，不再根据源码、模型名或历史日志猜测编译器与芯片。

## 2. 权威数据边界

| 信息 | 唯一权威来源 | 禁止行为 |
| --- | --- | --- |
| 构建后端 | `.eval/project.toml` 必须声明 `build_system="idf"` | 执行 Make/CMake/直接 GCC 或用 shell 绕过 |
| 编译器、链接脚本、分区表 | ESP-IDF 项目定义 | 编译工具注入工具链、链接脚本或芯片宏 |
| 目标芯片 | 已确认的项目目标配置及其证据 | 使用默认芯片、会话文本或模型猜测 |
| 镜像偏移 | ESP-IDF `flasher_args.json` | 仅凭扩展名或文件名猜测下载地址 |
| 构建产物 | 本次构建清单 | 扫描工作区后选择第一个 HEX |
| 构建日志 | 独立的 `build_log_lines` 存储 | 与普通 RunEvent 共用一个小容量窗口 |
| 宿主机进程能力 | `ProcessCapabilityBroker` + 具名工具执行器 | 从 bash、包装 shell 或脚本间接启动编译 |

显式配置优先于文件检测。自动检测只把包含 ESP-IDF `project.cmake`、`IDF_PATH`、
`idf_component_register` 或 `sdkconfig` 的工程识别为可执行后端；普通 CMake/Makefile
即使语法有效也不进入内置编译。

## 3. 数据流

```text
用户/主 Agent
    |
    v
compile 工具
    |
    +-- 目标确认门控 --------> 待用户选择的模态交互
    |
    v
BuildConfig
    |
    v
不可变 BuildRequest
    |
    +-- requestId
    +-- 后端和构建模式
    +-- 目标快照
    +-- 输入指纹
    +-- 有界并行数和超时
    |
    v
BuildExecutionGate
    |
    v
BuildBackend -> BuildPlan -> BuildRunner
                              |
                              +-- 类型化 stdout/stderr/info
                              +-- 进程树取消
                              +-- 结构化诊断
                              v
                         BuildProcessOutcome
                              |
                              v
                         ArtifactResolver
                              |
                              +-- 新产物/已变化产物
                              +-- 同输入指纹的认证复用
                              v
                         BuildRunManifest
                              |
                +-------------+-------------+
                v                           v
        独立构建日志                  DownloadEligibility
                                            |
                                            v
                              下载页只加载认证 ESP 多镜像固件包

通用 shell -----------------> ProcessCapabilityBroker
                                  |
                                  +-- diagnostic --------> 允许
                                  +-- embedded-build ----> 拒绝并要求 compile
                                  +-- opaque-process ----> 受管硬件工程中拒绝
```

## 4. 不可变 BuildRequest

一次构建开始前，系统生成并深度冻结 `BuildRequest`。后端执行、产物验证和下载资格判断共享同一快照，运行中不能被前端设置、另一个 Agent 或项目文件的后续修改悄悄替换。

请求包含：

- 权威项目根目录和实际构建目录；
- 后端来源是项目配置还是自动检测；
- `incremental`、`rebuild` 或 `clean` 模式；
- 目标、并行数、超时和可选预设；
- 已确认目标的型号、系列、证据、Profile 和可写区间；
- 构建定义、目标配置和相关源码共同计算出的 SHA-256 输入指纹。

输入发生变化时指纹必然变化。旧清单只有在输入指纹和文件哈希都一致时才允许作为 `verified-reuse` 使用。

## 5. 后端与执行器

后端只负责把请求转换为纯数据 `BuildPlan`：

- 唯一可执行后端是 IDF；
- IDF 后端执行项目声明的 IDF 流程；首次构建按已确认的
  `platform_target` 执行 `idf.py set-target`，不生成或复用 Arm 启动文件、链接脚本；
- `clean`、`rebuild` 和 `incremental` 是显式模式。

执行器负责通用能力：

- 在项目边界内运行命令；
- 分别保留 stdout、stderr 和 info 通道；
- 按阶段应用有界超时；
- 将 ESP-IDF、CMake、Ninja 和底层编译器输出解析为结构化诊断；
- 取消时终止完整进程树，而不是只结束父 shell；
- 无论成功或失败都原子写入运行清单。

Windows 上不同构建图通过主机级门控串行进入工具链，单个构建仍使用其 `jobs` 并行。其他平台允许有限的跨工程并发。Agent 数量不再直接等于宿主机编译进程数量。

工具查找优先使用真实可执行文件。Windows 已知安装目录优先于 Chocolatey/Scoop shim，避免 shim 的 PowerShell 包装层把工具异常误报成随机模型或编译失败。

### 5.1 进程能力 broker

`compile` 不再只是一个方便使用的工具名，而是宿主机唯一拥有 `embedded-build` 能力的具名
执行器。通用 `bash` 在 spawn 前必须经过 `ProcessCapabilityBroker`：

1. 直接识别 `idf.py/make/ninja/platformio/scons/west`、`cmake --build` 和交叉编译器；
2. 递归展开 `cmd /c`、`PowerShell -Command`、`sh -c`、`bash -lc`；
3. 将编码 PowerShell、包管理器脚本、脚本文件和不能静态审计的包装器标记为
   `opaque-process`；
4. 在受管硬件工作区只允许哈希、搜索、只读 Git 等诊断进程；
5. 任一 `embedded-build/opaque-process` 在创建子进程前失败关闭。

该 broker 基于可执行文件身份和进程结构，不是命令关键词黑名单。即使 Agent 改写自然语言、
嵌套多层 shell 或把命令放进 npm/pnpm 脚本，也不能绕过 ESP-only `compile` 边界。

## 6. 三种结果语义

### 6.1 BuildProcessOutcome

只描述进程：

- `succeeded`
- `failed`
- `cancelled`
- `timed-out`

退出码为 0 只能证明构建命令成功，不证明芯片配置正确，也不证明存在新固件。

### 6.2 BuildArtifactOutcome

只描述产物：

- `produced`：本次执行后新建或内容变化；
- `verified-reuse`：上次成功清单的输入指纹和文件哈希均与当前一致；
- 文件格式、大小、SHA-256、地址范围及诊断。

构建前已存在且本次未变化、又没有匹配认证清单的文件属于陈旧产物，不进入结果。

### 6.3 DownloadEligibility

只描述下载资格。下载提供者由构建清单决定，不由前端或模型猜测。

Eval 内置下载只有 `esptool/ESP-IDF` 一种提供者。非 ESP 项目仍可在 Eval 中完成源码和
驱动设计，但必须使用厂商工具手动下载。内置下载必须同时满足：

- ESP-IDF 生成 `flasher_args.json`；
- 清单中的每个 BIN 都属于本次构建认证产物，路径位于构建目录内且哈希未变化；
- 镜像偏移为合法 32 位地址并且地址范围不重叠；
- 清单芯片 target 与已确认项目 target 一致；
- 下载前由 esptool 在所选 USB Serial/JTAG、USB CDC 或 UART 端口识别实际芯片；
- 写入后对全部镜像执行 `verify-flash`，缺少明确校验证据时不得标记成功。

下载 API、Agent `flash` 工具和前端下载页共用同一个 ESP 范围门禁。它们不接受任意 HEX、
J-Link/J-Flash、模型提供的地址或原始下载命令，因此 UI 不能绕过后端资格判断。

因此“编译成功”和“可下载”是两个独立状态。

## 7. 日志与前端

构建日志写入独立的 `build_log_lines`，按会话和序列号持久化。应用重启后可恢复完整构建历史，普通对话 RunEvent 的裁剪不会删除构建日志。

SSE 仍保留一个较小的构建重放窗口，用于断线恢复；持久历史由构建日志接口提供。前端按照 durable event id 去重，不把工具内部数据或子 Agent 消息渲染为主 Agent 回复。

手动编译只需要 `auto-edit` 范围。编译工具具备工作区读写和进程效果，但不获得网络、硬件或任意全权限。

## 8. 目标确认交互

目标不明确时，编译请求进入 `target-confirmation` 挂起态：

1. 系统收集本地构建定义、芯片宏、已提炼的原理图和文档证据；
2. 前端显示可取消的选择弹窗；
3. 用户确认后原子持久化目标；
4. 同一个编译操作恢复执行，不重新请求模型，也不创建第二个任务；
5. 用户取消则结束该操作，不伪装成编译失败。

已经存在的新鲜会话原理图投影和文档投影会被复用，编译流程不会反复调用视觉模型。

## 9. 验收不变量

以下条件必须由自动化测试持续保证：

- 显式后端配置不会被项目内其他构建文件覆盖；
- 非 ESP 工程在创建 BuildRequest 前失败关闭；
- bash 中的 Make/CMake/Ninja/交叉 GCC 不能绕过同一编译边界；
- 非 ESP 项目初始化和源码编辑保持可用；
- ESP 支持由芯片平台元数据决定，不硬编码型号列表；
- IDF 首次构建使用已确认的精确 `platform_target`；
- 构建请求在执行期间不可变；
- 源码或配置变化会改变输入指纹；
- 陈旧产物不会通过认证；
- stderr 不会被伪装成 stdout；
- 取消会终止子进程；
- 下载页只能看到最新成功清单认证的固件；
- ESP 下载页只能看到认证清单声明的多 BIN、偏移、大小和哈希；
- 下载 API 和 Agent 工具只能接受 ESP-IDF/esptool 合约，非 ESP 项目在进程启动前失败关闭；
- J-Link/J-Flash、任意 HEX 和模型提供的地址不能进入内置下载路径；
- 原生 USB Serial/JTAG、USB CDC 与 USB-UART 统一为端口传输层，但仍需实际芯片识别；
- 目标不同或文件哈希变化会关闭下载资格；
- 大量构建日志不会驱逐会话控制事件；
- 多工程压力下 requestId、产物和日志互不串线。

## 10. 2026-07-29 验证基线

当前工作树已经验证：

- ESP-IDF 项目可以生成不可变 BuildRequest 和 `idf.py` BuildPlan；
- 已确认的非 ESP Make/CMake 工程在启动进程前返回 `unsupported-build-platform`；
- 同一非 ESP 芯片仍可由 `project_init` 生成源码工程并继续文件编辑；
- 非 ESP 构建命令不能通过直接 bash、嵌套 cmd/PowerShell/sh、包脚本或脚本文件绕过门禁；
- ESP 多 BIN 篡改、目录穿越、镜像重叠、目标芯片不匹配和下载后校验继续通过专项测试；
- Core 全量测试 445/445 通过；
- App 全量测试 87/87 通过；
- 多 Agent 压测覆盖 380 个 DAG、2560 个节点，架构违规为 0；
- 编排压测覆盖 8000 条日志、100 个 productive segments 和 5000 个 continuation cycles；
- 构建压测覆盖 12 个 ESP 工程，全部生成认证 bundle，5000 行构建日志互不串线。

该架构不保留旧的直接 GCC 推断、全局验证和工作区 HEX 扫描兼容路径。
