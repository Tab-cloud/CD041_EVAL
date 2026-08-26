# Eval Backend Features — 功能清单与维护文档

> 自动生成于 2026-08-26 | 基于 `packages/core/src/` 代码审计
> 执行循环与多 Agent 的权威架构说明见 `agent-execution-loop-architecture.md`，
> 编译流水线见 `build-pipeline-architecture.md`。

---

## 一、项目架构总览

```
packages/core/src/
├── index.ts               # 库导出入口（不监听端口）
├── runtime/               # HTTP 服务、Agent 循环、LLM 客户端、任务调度（约 130 个文件）
│   ├── index.ts           # 真实服务启动入口 (Bun.serve :4096)
│   ├── server.ts          # 主 HTTP 路由 + 安全前置（Origin 白名单 / Token / CORS）
│   ├── server-chat.ts     # POST /api/chat SSE 流式对话
│   ├── server-tasks.ts    # 任务 / 检查点 / 会话命令路由
│   ├── server-workflows.ts# 工作流路由
│   ├── server-programmer.ts # 烧录器路由
│   ├── agent-loop*.ts     # Agent 循环（轻量回合策略，约 10 个文件）
│   ├── execution-*.ts     # 执行流 / 预算 / 调度 / 终态
│   ├── model-*.ts         # 模型失败策略 / 限额 / 重试 / 就绪
│   ├── server-chat-*.ts   # 聊天请求 / 策略 / 投影 / 路由 / 准入
│   ├── runtime-protocol.ts # 运行时协议版本（v6，33 种 SSE 事件）
│   ├── orchestrator.ts    # AgentOrchestrator
│   ├── planner.ts         # 任务分解（LLM 拆子任务）
│   └── workflow-engine.ts # 工作流引擎
├── tool/                  # 36 个内置工具（EMBEDDED_TOOLS）
│   ├── fs/                # 6 个文件系统工具
│   ├── general/           # 9 个通用工具（bash/task/delegate_dag 等）
│   ├── schematic/         # 3 个原理图工具
│   ├── hardware/          # 11 个硬件/编译/烧录工具
│   └── community/         # 7 个 Eval Web 社区工具
├── agent/                 # 20 个 Agent 定义
│   ├── registry.ts        # AgentRegistry
│   └── definitions/       # main-agent / subagents / component / all
├── skills/                # 8 个内置技能 (.md) + loader/manager
├── knowledge/chips.ts     # 芯片知识库（CHIP_DATABASE）
├── mcp/                   # MCP 客户端 / 管理器 / 安全
├── model-router/          # 模型路由（能力评分）
├── project/               # ProjectManager（.eval/project.toml）
├── store/                 # SQLite 持久化（30 个模块，55 个迁移版本）
├── util/                  # PDF / Office 解析与写入
└── vision/client.ts       # 视觉模型客户端
```

---

## 二、进程模型与部署

- 服务入口 `packages/core/src/runtime/index.ts`，`Bun.serve` 默认监听 `127.0.0.1:4096`（`HOST`/`PORT` 可覆盖）。
- 桌面壳 Tauri 2 通过 `plugin-shell` 拉起 `eval-server` 可执行文件，前端用 HTTP + SSE 通信。
- 鉴权：启动时校验 `EVAL_AGENT_TOKEN`（无 Token 且未显式允许则拒绝启动）；请求过 `server-security.ts`（Origin 白名单 + `x-eval-agent-token` + 动态 CORS，禁止 `*`）。
- 持久化：SQLite `~/.eval/eval.db`（`EVAL_DATA_DIR` 可覆盖），WAL 模式，迁移到 55 版；诊断日志 `~/.eval/log.txt`（8 MiB 轮转，敏感字段脱敏）。
- 单实例：`runtime_leader_lease` / `runtime_owner_leases` 租约表拒绝第二个实例并行调度。
- 构建：`bun build --compile` 生成 `eval-server`（macOS Universal 用 `lipo` 合并 arm64/x64）；串口旁车 `tools/eval-serial` 为 Rust 子进程，JSON 输出。

---

## 三、HTTP 路由清单

### 核心对话与会话

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | SSE 流式对话（核心端点） |
| GET | `/api/messages` | 会话消息（已脱敏投影） |
| GET/POST/DELETE | `/api/sessions` | 会话列表 / 创建 / 删除 |
| POST | `/api/sessions/archive` `/unarchive` | 归档（生成摘要）/ 取消归档 |
| POST | `/api/sessions/compact` | 压缩 LLM 上下文 |
| POST | `/api/sessions/clear` | 清空会话 |
| GET/DELETE | `/api/sessions/artifacts` | 会话产物 |
| PATCH | `/api/sessions/preferences` | 会话写作偏好 |
| POST | `/api/sessions/runtime-access` | 会话运行时访问范围（scope） |
| GET | `/api/archive/search` | 归档摘要搜索 |
| GET | `/api/health` | 健康检查（协议版本、工具/Agent 数量） |
| GET | `/api/agents` | Agent 列表 |

### 任务 / 检查点 / 命令

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/DELETE | `/api/tasks` | 任务队列 |
| GET | `/api/tasks/status` | 任务状态 + 待审批/提问投影 |
| GET | `/api/tasks/events` | 任务事件（增量 JSON） |
| POST | `/api/tasks/cancel` `/retry` | 取消 / 重试 |
| POST | `/api/tasks/guidance` | 运行中追加引导 |
| POST | `/api/attachments` | 附件上传 |
| GET/POST/DELETE | `/api/session-commands` | 会话命令 |
| GET | `/api/session-commands/stream` | SSE 命令回放 |
| GET/DELETE | `/api/tasks/logs` `/build/logs` | 任务 / 构建日志 |
| GET | `/api/checkpoint` | 检查点摘要 |
| POST | `/api/checkpoint/resume` | 从检查点恢复 |
| DELETE | `/api/checkpoint` | 删除检查点 |

### 运行图 / 编排 / 审批

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/runs/:runId/contract` | 运行契约 |
| GET | `/api/run-graphs/:id` | 运行图 |
| GET | `/api/run-graphs/:id/events` | 运行图事件（增量） |
| GET | `/api/run-graphs/:id/stream` | SSE 运行图事件流 |
| GET | `/api/orchestration/logs` | 多 Agent 编排日志 |
| GET | `/api/model-attempts` | 按 runId 查询模型尝试 |
| POST | `/api/approvals/respond` | 工具审批应答 |
| POST | `/api/questions/respond` `/cancel` | 用户提问应答 / 取消 |
| GET | `/api/tool-executions` | 工具执行历史 |
| POST | `/api/tool-executions/undo` | 撤销工具执行 |

### 配置 / 模型 / 工具 / 技能 / MCP

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/api/models` | 模型配置 |
| POST | `/api/models/validate` `/import` `/preset` | 校验 / 导入 / 预设 |
| GET/PUT | `/api/settings` | 系统设置 |
| GET/PUT/DELETE | `/api/project-settings` | 项目级设置覆盖 |
| GET | `/api/tools` | 工具目录（可按 projectPath） |
| POST | `/api/tools/test` | 测试单个工具 |
| GET | `/api/skills` | 技能列表 |
| POST | `/api/skills/install` | 安装技能（URL/Git/本地/内容） |
| DELETE | `/api/skills` | 删除技能 |
| GET/PUT | `/api/custom-agents` | 自定义 Agent |
| GET/PUT | `/api/mcp/servers` | MCP 服务器 |
| POST | `/api/mcp/validate` `/connect` | MCP 校验 / 启停 |
| POST | `/api/test-connection` | 测试模型连接 |

### 项目 / RAG / 诊断 / 用量

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/projects/init` | 初始化项目（`.eval/project.toml`） |
| GET | `/api/rag/search` | RAG 项目文档检索 |
| GET | `/api/diagnostics` `/diagnostics/report` | 诊断快照 |
| GET | `/api/config/backup` | 导出配置备份 |
| POST | `/api/config/restore` | 恢复配置备份（带回滚） |
| GET | `/api/usage` | 用量统计 |
| GET | `/api/usage/heatmap` | Token 每日热力图 |
| GET | `/api/logs` | LLM 调用日志 |
| GET | `/api/search/test` | 测试搜索提供商 |
| GET/PUT/DELETE | `/api/runtime/community-session` | 社区 Token 连接状态 |

### 工作流

`GET/POST/DELETE /api/workflows`、`POST /api/workflows/action`、`GET /api/workflows/report`、
`GET /api/workflows/analytics`、`GET/POST/PUT/DELETE /api/workflow-templates`、
`GET/POST/PUT/DELETE /api/workflow-schedules`、`POST /api/workflow-schedules/run`、
`GET/PUT/POST /api/workflow-webhook*`。

### 串口 / 终端 / 烧录器

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/terminal/exec` | SSE 终端命令执行 |
| GET | `/api/serial/ports` | 串口列表 |
| POST | `/api/serial/send` | 串口发送 |
| POST | `/api/serial/monitor` | SSE 串口监听 |
| GET | `/api/programmer/status` | 烧录器状态 |
| POST | `/api/programmer/install-esptool` | 安装 esptool |
| POST | `/api/programmer/connect` | 连接设备 |
| POST | `/api/programmer/flash` | SSE 烧录 |

**SSE 端点（6 个）**：`POST /api/chat`、`GET /api/run-graphs/:id/stream`、
`GET /api/session-commands/stream`、`POST /api/terminal/exec`、`POST /api/serial/monitor`、
`POST /api/programmer/flash`。

---

## 四、运行时协议（SSE 事件）

`runtime-protocol.json`（仓库根目录）定义前后端共享的 SSE 协议，当前版本 6，
共 30 种事件，由 `scripts/generate-runtime-protocol.mjs` 生成 TS 类型。事件清单：

`heartbeat`、`session`、`task-status`、`graph-event`、`serial-context`、`context-compaction`、
`execution-state`、`execution-stopped/continued/blocked/phase`、`assistant-part`、`tool-call`、
`tool-result`、`tool-status`、`tool-stream`、`context-capacity`、`model-routed`、`model-attempt`、
`plan-submitted`、`question-request/resolved`、`approval-request/resolved`、`tool-execution`、
`agent-activity`、`agent-progress`、`artifact-updated`、`error`、`done`。

---

## 五、工具清单（36 个）

### 文件系统（6）

`read`、`write`、`edit`、`move`、`glob`、`grep`

### 通用（9）

`bash`、`webfetch`、`websearch`、`todowrite`、`plan`、`question`、`task`、`delegate_dag`、`skill`

### 原理图 / 器件（3）

`schematic_read`、`pin_extract`、`datasheet_read`

### 硬件 / 编译烧录 / 串口 / 调试（11）

`compile`（ESP-IDF 内置编译，唯一 `embedded-build` 能力所有者）、`flash`（esptool 下载 + 校验）、
`serial_open`、`serial_monitor`、`swd_debug`、`usb_detect`、`project_init`、`chip_add`、
`lvgl_gen`、`write_office`、`ocr_image`

### Eval Web 社区（7）

`community_forum_list/read/create_topic/reply`、`community_blog_create_draft/update_draft/publish`

运行时还会通过 `mcpManager.attach(toolReg)` 动态挂载 MCP 工具。
`bash` 在 spawn 前必须经过 `ProcessCapabilityBroker` 分类（diagnostic / embedded-build /
opaque-process），无法绕过 ESP-only 编译边界。

---

## 六、Agent 定义（20 个）

| ID | 名称 | 模式 |
|----|------|------|
| `main-agent` | 主 Agent | 根入口（会话唯一 owner） |
| `component-researcher` | 器件研究员 | hidden |
| `project-initializer` | 项目初始化 | hidden |
| `researcher` | 联网研究员 | hidden |
| `requirements-analyst` | 需求分析师 | hidden |
| `hardware-engineer` | 硬件工程师 | hidden |
| `software-engineer` | 软件工程师 | hidden |
| `firmware-engineer` | 固件工程师 | hidden |
| `build-agent` | 编译工程师 | hidden |
| `ui-engineer` | UI工程师 | hidden |
| `architect` | 资深架构师 | hidden |
| `os-engineer` | OS工程师 | hidden |
| `test-engineer` | 测试工程师 | hidden |
| `doc-writer` | 文档工程师 | hidden |
| `planner` | 计划工程师 | hidden |
| `debug-engineer` | 调试工程师 | hidden |
| `general` | 通用助手 | hidden |
| `explore` | 代码探索 | subagent |
| `title-gen` | 标题生成 | hidden（内部） |
| `summary-gen` | 摘要生成 | hidden（内部） |

权限边界：只有 `runType=root + agentId=main-agent` 可调用 `task` 和 `delegate_dag`；
子 Agent 只返回结构化 `TaskResult`，不能创建下级 Agent；子任务由
`TaskSettlementService` 单事务直接结算（无二次评分/评审状态机）。

---

## 七、技能文件（8 个内置）

`stm32-hal.md`、`freertos.md`、`lvgl-ui.md`、`arm-debugging.md`、`component-selection.md`、
`architecture-audit.md`、`chip-support-boundary.md`、`write-blog.md`

支持从 URL / Git 仓库 / 本地路径 / 内容安装新技能。

---

## 八、持久化（SQLite，55 个迁移版本）

- 基础：`database.ts`、`database-schema.ts`、`repository.ts`（Session/Message/Project）
- 运行：`task-run.ts`、`execution-run.ts`、`run-contract.ts`、`run-graph.ts`、`run-event.ts`、
  `checkpoint.ts`、`conversation-objective.ts`
- 会话：`session-command.ts`、`session-command-terminal.ts`、`session-artifact.ts`、
  `tool-approval-record.ts`、`tool-execution.ts`
- 审计：`call-log.ts`、`build-log.ts`、`orchestration-log.ts`、`model-attempt.ts`、
  `token-usage.ts`
- 工作流：`workflow.ts`、`workflow-template.ts`、`workflow-webhook.ts`
- 租约 / 配置：`runtime-leader-lease.ts`、`runtime-owner-lease.ts`、`project-config.ts`

---

## 九、前端结构

Tauri 2 + React 19 + TypeScript + Vite 7。`app/src/` 约 65 个组件：

- 聊天区：ChatView / ChatInput / ChatMessages / ToolApprovalCard / UserQuestionDialog
- 面板：LeftSidebar / RightPanel / BottomPanel / TasksPanel / ChangesPanel / WorkLogPanel /
  DownloadPanel / TokenHeatmap / ContextUsagePanel
- 设置：Settings（Account / Agents / Community / Diagnostics / Mcp / ModelRouting / Project /
  Search / Skills / ToolCenter / ToolPolicies / SystemSettings / ModelConfig）
- 工作流：WorkflowPanel / WorkflowGraph / WorkflowAnalytics / WorkflowSchedulePanel /
  WorkflowTemplateEditor / WorkflowWebhookPanel / WorkflowRunDetails
- 后端通过 `app/src/api.ts` + `src/sse.ts` 与 eval-server 通信；状态管理在 `src/store.ts`
