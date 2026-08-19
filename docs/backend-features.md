# Eval Backend Features — 功能清单与维护文档

> 自动生成于 2026-07-06 | 基于 `packages/core/src/` 代码审计

---

## 一、项目架构总览

```
packages/core/src/
├── runtime/          # HTTP服务、Agent循环、LLM客户端、任务调度
│   ├── index.ts         启动入口 (Bun.serve :4096)
│   ├── server.ts         HTTP路由 (22端点) + SSE推送
│   ├── agent-loop.ts     Agent循环 (15轮 max)
│   ├── llm-client.ts     LLM流式调用 (Vercel AI SDK)
│   ├── llm-manager.ts    用量统计 / 模型健康 / fallback链
│   ├── task-scheduler.ts 优先级任务队列
│   ├── orchestrator.ts   关键词 → Agent路由
│   ├── planner.ts        任务分解器 (LLM拆子任务)
│   ├── reflection.ts     编译-修复自省循环
│   ├── agent-chain.ts    5条多Agent流水线
│   └── config-store.ts   模型配置持久化
├── tool/             # 25个工具
│   ├── fs/              5个文件系统工具
│   ├── general/         7个通用工具
│   ├── schematic/       3个原理图工具
│   └── hardware/        10个硬件工具
├── agent/            # 17个Agent定义
├── skills/           # 6个技能文件 (.md)
├── model-router/     # 模型路由 (能力评分)
├── store/            # SQLite持久化
└── util/             # PDF/Office解析
```

---

## 二、API 端点清单（22个）

### 模型配置

| 方法 | 路径 | 状态 | 前端对接 |
|------|------|:---:|:---:|
| GET | `/api/models` | ✅ | ❌ |
| PUT | `/api/models` | ✅ | ✅ ModelConfigModal |
| POST | `/api/models/import` | ✅ | ❌ |
| POST | `/api/models/preset` | ✅ | ❌ |

### 会话管理

| 方法 | 路径 | 状态 | 前端对接 |
|------|------|:---:|:---:|
| GET | `/api/sessions` | ✅ | ❌ (前端本地管理) |
| POST | `/api/sessions` | ✅ | ❌ (前端本地创建) |
| DELETE | `/api/sessions?id=` | ✅ | ✅ LeftSidebar |
| POST | `/api/sessions/archive` | ✅ | ✅ LeftSidebar |

### 消息

| 方法 | 路径 | 状态 | 前端对接 |
|------|------|:---:|:---:|
| GET | `/api/messages?sessionId=` | ✅ | ✅ 切换会话加载历史 |
| POST | `/api/chat` | ✅ SSE | ✅ handleSend |

### 监控 & 调试

| 方法 | 路径 | 状态 | 前端对接 |
|------|------|:---:|:---:|
| GET | `/api/health` | ✅ | ❌ |
| GET | `/api/agents` | ✅ | ❌ (前端硬编码5个) |
| GET | `/api/usage` | ✅ | ❌ |
| GET | `/api/logs` | ✅ | ❌ |
| GET | `/api/tasks` | ✅ | ❌ |
| DELETE | `/api/tasks` | ✅ | ❌ |

#### 本地诊断文件

- 后端同时把结构化编排事件写入 `$EVAL_DATA_DIR/log.txt`；桌面版默认位置为 `%USERPROFILE%\.eval\log.txt`。
- 每行是一个 JSON 事件，包含时间、级别、eventType、sessionId、runId、requestId（位于 data 中）、状态与事件投影版本，便于按一次请求重建执行链。
- 文件达到 8 MiB 后轮转为 `log.1.txt`；SQLite 编排日志仍是权威记录，文本日志故障不会改变任务状态。
- 密码、Token、Cookie、Authorization 等敏感字段在写入前统一脱敏；不记录模型思考正文、附件正文或完整提示词。

### 高级功能

| 方法 | 路径 | 状态 | 前端对接 |
|------|------|:---:|:---:|
| GET | `/api/rag/search` | ✅ | ❌ |
| GET | `/api/checkpoint` | ✅ | ❌ |
| GET | `/api/workflows` | ✅ | ❌ |
| GET | `/api/archive/search` | ✅ | ❌ |
| POST | `/api/test-connection` | ✅ | ✅ ModelConfigModal |
| GET | `/stable.json` | ⚠️ 占位 | ❌ |

**对接率: 6/22 (27%)**

---

## 三、SSE 事件（8种）

| 事件 | 数据结构 | 前端处理 |
|------|---------|:---:|
| `text` | `{ text: string }` | ✅ UPDATE_LAST_MESSAGE |
| `thinking` | `{ status: "start"\|"end" }` | ✅ SET_THINKING |
| `tool-status` | `{ id, name, status, input }` | ✅ workLog + toolStatus |
| `tool-call` | `{ name, input }` | ✅ addLogLine |
| `tool-result` | `{ id, name, result }` | ✅ addLogLine + workLog error |
| `context-capacity` | `{ used, total, breakdown, usage }` | ✅ ContextUsagePanel |
| `error` | `{ message }` | ✅ UPDATE_LAST_MESSAGE |
| `done` | `{ sessionId, taskId }` | ❌ 未处理 |

**对接率: 7/8 (87.5%)**

---

## 四、工具清单（25个）

### 文件系统 (5个，全部真实)

| 工具 | 描述 | 权限 |
|------|------|------|
| `read` | 读取文件/目录 | ✅ |
| `write` | 写入文件 | ✅ |
| `edit` | 查找替换 | ✅ |
| `glob` | 文件模式搜索 | ✅ |
| `grep` | 内容搜索 | ✅ |

### 通用 (7个)

| 工具 | 描述 | 状态 |
|------|------|:---:|
| `bash` | 执行shell命令 | ✅ |
| `webfetch` | 获取网页内容 | ✅ |
| `websearch` | DuckDuckGo搜索 | ✅ |
| `todowrite` | 任务列表 | ✅ |
| `question` | 向用户提问 | ✅ |
| `task` | 启动子Agent | ⚠️ Stub |
| `skill` | 加载技能文件 | ✅ |

### 原理图 (3个)

| 工具 | 描述 | 状态 |
|------|------|:---:|
| `schematic_read` | 读取原理图PDF/图片 | ✅ |
| `pin_extract` | 提取引脚映射 | ✅ |
| `datasheet_read` | 读取数据手册 | ✅ |

### 硬件 (10个)

| 工具 | 描述 | 状态 |
|------|------|:---:|
| `compile` | 编译 Espressif ESP 系列原生 ESP-IDF 固件；非 ESP 仍可设计代码并在外部环境手动编译 | ✅ |
| `flash` | 通过原生 USB、USB-UART 或 UART 下载并校验 ESP-IDF 认证固件包；非 ESP 使用厂商工具手动下载 | ✅ |
| `serial_open` | 串口操作 | ⚠️ 部分(Tauri对接) |
| `serial_monitor` | 串口监听 | ⚠️ 部分(Tauri对接) |
| `swd_debug` | SWD调试 | ✅ |
| `usb_detect` | USB设备检测 | ✅ |
| `project_init` | 项目初始化 | ✅ |
| `lvgl_gen` | LVGL代码生成 | ✅ |
| `write_office` | Office文档生成 | ✅ |
| `ocr_image` | 图片OCR | ✅ |

**真实实现: 24/25 (96%) | Stub: 1 (task)**

---

## 五、Agent 定义（17个）

| ID | 名称 | 模式 | 工具数 |
|----|------|------|:---:|
| `component-researcher` | 器件研究员 | hidden | 6 |
| `researcher` | 资料研究员 | hidden | 5 |
| `requirements-analyst` | 需求分析师 | hidden | 3 |
| `hardware-engineer` | 硬件工程师 | hidden | 5 |
| `software-engineer` | 软件工程师 | hidden | 5 |
| `firmware-engineer` | 固件工程师 | hidden | 9 |
| `ui-engineer` | UI工程师 | hidden | 5 |
| `architect` | 架构师 | hidden | 5 |
| `os-engineer` | OS工程师 | hidden | 7 |
| `test-engineer` | 测试工程师 | hidden | 4 |
| `doc-writer` | 文档工程师 | hidden | 5 |
| `planner` | 计划工程师 | hidden | 3 |
| `debug-engineer` | 调试工程师 | hidden | 6 |
| `general` | 通用助手 | **subagent** | 10 |
| `explore` | 代码探索 | **subagent** | 5 |
| `title-gen` | 标题生成 | hidden | 0 |
| `summary-gen` | 摘要生成 | hidden | 0 |

**AgentChain 流水线 (5条)**：full-development / quick-prototype / debugging / component-selection / ui-development

---

## 六、技能文件（6个）

| 文件 | 技能名 | 描述 |
|------|--------|------|
| `stm32-hal.md` | stm32-hal | STM32 HAL库开发 |
| `freertos.md` | freertos | FreeRTOS配置 |
| `lvgl-ui.md` | lvgl-ui | LVGL界面开发 |
| `arm-debugging.md` | arm-debugging | ARM调试方法论 |
| `component-selection.md` | component-selection | 器件选型 |
| `architecture-audit.md` | architecture-audit | 系统架构审计 |

---

## 七、前端对接状态总结

### 已对接 ✅

| 功能 | 对接方式 |
|------|---------|
| 流式对话 | SSE text → ChatView |
| Thinking 状态 | SSE thinking → 思考指示器 |
| 工具执行状态 | SSE tool-status → 工作状态面板 |
| 操作日志 | SSE tool-status/result → workLog面板 |
| 上下文用量 | SSE context-capacity → RightPanel |
| 会话切换 | GET /api/messages → 加载历史 |
| 会话归档 | POST /api/sessions/archive |
| 会话删除 | DELETE /api/sessions |
| 模型配置 | PUT /api/models + 测试连接 |
| 推理档位 | 前端EffortMode下拉 |
| Plan模式 | scope → system prompt注入 |

### 未对接 ❌（待实现）

| 优先级 | 功能 | 说明 |
|:---:|------|------|
| 🔴 | **SSE `done` 事件** | 前端未处理，错过完成通知 |
| 🔴 | **`task` 工具 (Stub)** | 子Agent委派仅返回占位文本 |
| 🟡 | `/api/health` 健康检查 | 启动时可检测后端是否在线 |
| 🟡 | `/api/agents` Agent列表 | 前端硬编码5个，后端有17个 |
| 🟡 | `/api/sessions` 会话同步 | 前端本地管理，启动时不从后端加载 |
| 🟡 | `/api/usage` 用量统计 | 无Token/费用面板 |
| 🟡 | `/api/logs` 调用日志 | 无LLM调用记录面板 |
| 🟡 | `/api/tasks` 任务队列 | 无任务调度监控面板 |
| 🟡 | `/api/archive/search` 归档搜索 | 无搜索栏 |
| 🟢 | `/api/models/import` | ModelConfigModal无导入按钮 |
| 🟢 | `/api/models/preset` | ModelConfigModal无预设选择器 |
| 🟢 | `/api/rag/search` 语义搜索 | 无搜索UI |
| 🟢 | `/api/checkpoint` 断点恢复 | 无恢复UI |
| 🟢 | `/api/workflows` 多Agent流水线 | 无工作流启动器 |
| 🟢 | `serial_open/monitor` 串口面板 | serialOutput状态空 |
| 🟢 | `swd_debug` 调试面板 | debugOutput状态空 |
| 🟢 | `project_init` 项目向导 | 无UI |
| 🟢 | `lvgl_gen` 界面生成器 | 无UI |

---

## 八、建议新增的功能

### 工具类
- [ ] **`audit` 工具** — 自动化系统架构审计（替代依赖 skill 的手动流程）
- [ ] **`perf` 工具** — 性能分析（编译时间、内存占用）
- [ ] **`diff` 工具** — 文件对比
- [ ] **`git` 工具** — Git 操作封装

### 技能类
- [x] **ESP-IDF 平台适配** — 原生工程生成、`idf.py` 构建、多 BIN 认证、esptool USB/UART 下载与校验
- [ ] **`nordic-nrf`** — Nordic nRF52/nRF53 开发技能
- [ ] **`risc-v`** — RISC-V MCU 开发技能
- [ ] **`ble-mesh`** — BLE Mesh 协议技能

### 前端面板
- [ ] **用量分析面板** — Token/费用/调用统计 (对接 /api/usage, /api/logs)
- [ ] **任务队列面板** — 实时任务状态 (对接 /api/tasks)
- [ ] **Agent 选择器** — 从 /api/agents 动态加载
- [ ] **串口终端面板** — 对接 serialOpen/Monitor
- [ ] **调试面板** — 对接 swd_debug
- [ ] **RAG 搜索栏** — 对接 /api/rag/search
- [ ] **工作流启动器** — 对接 /api/workflows

---

## 九、已知技术债务

| 项目 | 位置 | 说明 |
|------|------|------|
| ⚠️ Stub | `tool/general/task.ts` | 子Agent委派返回占位文本 |
| ⚠️ 占位 | `server.ts:/stable.json` | 更新检测返回固定值 |
| ⚠️ 未使用 | `agent-loop.ts:discoverSkills()` | 之前返回值未注入提示词 (已修复) |
| ⚠️ 硬编码 | `store.ts:agents[]` | 前端Agent列表硬编码5个 |
| ⚠️ 未对接 | `serial_open/monitor` | Tauri后端需完成Rust实现 |
| ⚠️ 未使用 | `planner.ts` TaskDecomposer | 已实现但handleChat未调用 |
| ⚠️ 未使用 | `reflection.ts` SelfCritic | 已实现但agent-loop未调用 |
| ⚠️ 未使用 | `agent-chain.ts` 5条流水线 | 已定义但无触发入口 |
| ⚠️ TypeScript | `planner.ts:58` | 预存TS1127编译错误 |
