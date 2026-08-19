# Eval Agent 编排架构与系统测试交付文档

> 交付日期：2026-07-31
> 项目目录：`H:\Prj\CD041_LUBAN\embedded-agent`
> 当前任务：修复主 Agent 在复杂任务中重复调用、子 Agent 未启动、任务长时间无交互并最终失败的问题
> 系统测试场景：`请给我一个电源设计方案，将12V的太阳能板转换成220V的家用电的逆变方案`
> 当前结论：核心架构改动已部分落地，但新增的完整系统测试仍失败，禁止标记完成或进入发布打包。

## 1. 本文档的用途

本文档用于把当前会话中已经完成的调查、架构决策、代码改动、测试证据和剩余任务交给后续执行者。接手者应从本文档的“P0 剩余任务”继续，不要重新从界面现象开始猜测，也不要使用关键字判断、增加重试次数或输出兜底文案来掩盖问题。

当前没有应被假定为仍在后台可靠运行的修复任务。权威状态是本地工作区、测试结果和编排日志，而不是前端“处理中”动画。

## 2. 用户要求与验收目标

用户要求：

1. 先给出解决方案。
2. 对解决方案进行架构审查。
3. 完成代码落地。
4. 执行系统级测试，而不仅是单元测试。
5. 使用现有主 Agent + 原子子 Agent 架构模拟上述太阳能逆变方案请求。
6. 跟踪真实安装版 Eval 中正在执行的同类任务，判断整个流程是否正常。

最终验收不是“模型返回过文本”或“工具调用数量增加”，而是以下闭环：

```text
用户输入
  → 会话主 Agent 取得唯一命令所有权
  → 语义意图和目标合同生成
  → 规划阶段取得 plan 协议工具
  → 发布不可变 PlanContract
  → 主 Agent 按计划只委派一次
  → 子 Agent 取得调度租约
  → 子 Agent 使用网络工具取得外部研究证据
  → 子 Agent 提交结构化结果
  → 主 Agent 仲裁验收
  → 已验收证据晋升到根目标
  → 主 Agent 生成最终用户回复
  → SSE、任务状态、右侧清单和持久化状态一致地进入 completed
```

## 3. 生产问题证据

此前对真实安装版运行进行了数据库和编排日志检查，确定这不是单一模型偶发失败。

- 真实运行 ID：`task-28a5a0a1-01ed-421c-8381-4e998acd1ea4`
- 会话 ID：`7706ed7f-5c04-4b1a-9b55-c844c9941c97`
- 输入：与本系统测试相同的 12V 太阳能板转 220V 逆变方案请求
- 运行时间：约从 15:01:53 持续到 15:19:22 后取消
- 工具行为：
  - `websearch` 成功约 43 次
  - `plan` 被拒绝约 20 次
  - `webfetch` 失败约 3 次
  - 模型尝试约 58 次
- 缺失的关键状态：
  - 没有可靠的 `root.tasks-published`
  - 没有形成最终 Assistant 交付
  - 大量不同搜索词被错误当作“有进展”

根因之一是目标能力和运行时协议能力被混为一体：研究目标只声明 `network`，而规划阶段必须调用 `plan`；`plan` 属于控制面工具，不应迫使研究目标获得所有 `user-interaction` 能力，也不应因目标能力过滤而消失。

## 4. 已审查并采用的目标架构

### 4.1 领域能力与控制面租约分离

目标合同只声明完成业务目标真正需要的效果，例如：

- `network`
- `workspace-read`
- `workspace-write`
- `process`
- `hardware`
- `delegation`

执行阶段合同单独声明本阶段允许使用的精确控制工具，例如：

- 规划阶段：`plan`、`question`、`todowrite`
- 执行阶段：`question`、`todowrite`

控制工具只能按名称获得短期租约，不能借此扩展整个效果类别。系统权限、Agent 白名单、禁用工具和用户权限范围仍然具有更高优先级。

### 4.2 模型调用前执行可满足性预检

每个执行阶段可声明 `requiredToolNames`。运行时必须在调用模型之前验证这些工具真实可见。

例如自动规划阶段必须看见 `plan`。如果不可见，应直接产生结构化 `execution.contract-rejected`，而不是让模型反复尝试一个永远不可用的协议。

### 4.3 进展由目标状态定义，不由活动数量定义

以下行为不能单独续命：

- 换一个关键词再次搜索。
- 重复读取相同文件并取得相同内容。
- 重复调用同一失败的委派。
- 仅产生新的工具执行 ID。
- 输出“正在继续”但没有新增验收证据。

只有以下变化可作为进展：

- 新证据绑定到目标验收条件。
- 文件或工作区发生被合同允许的实质变化。
- 构建、测试、硬件观测等验收状态改变。
- 子任务通过主 Agent 仲裁。
- 恢复策略首次产生不同且可验证的结果。

### 4.4 子 Agent 证据必须经过主 Agent 仲裁后晋升

子 Agent 原始结果不能直接使根任务完成。信任边界为：

```text
子 Agent 工具证据
  → 子任务结构化结果
  → task_review 对每条验收标准评分
  → 仅通过的 evidenceRefs 被晋升
  → 根目标证据账本
```

仲裁未通过时必须生成修订计划；不能把未验收的子结果当作根任务进展。

### 4.5 纯研究节点不强制伪造文件产物

`expectedOutputs` 只描述持久文件产物。纯研究节点可以使用空数组，交付物由强制验收证据表达。此前强制至少一个文件会使只有网络读取权限的研究 Agent 得到不可满足合同。

## 5. 已落地的代码改动

以下改动位于当前未提交工作区中，接手时必须先核对差异，不能覆盖。

### 5.1 阶段合同与工具可见性

- `packages/core/src/runtime/execution-flow.ts`
  - `ExecutionPhaseContract` 新增 `controlToolNames` 和 `requiredToolNames`。
  - 自动规划阶段精确租用 `plan/question/todowrite`，并要求 `plan` 必须可见。
- `packages/core/src/runtime/agent-loop-types.ts`
  - `AgentLoopInput` 新增 `phaseControlTools` 和 `requiredPhaseTools`。
- `packages/core/src/runtime/tool-policy.ts`
  - 目标效果过滤支持精确控制工具旁路。
  - 旁路不越过系统策略、Agent 白名单、用户范围和显式禁用。
- `packages/core/src/runtime/agent-loop.ts`
  - 在模型调用前检查阶段必需工具。
  - 不可满足时记录 `execution.contract-rejected` 并停止该阶段。
- `packages/core/src/runtime/server-chat.ts`
  - 把阶段控制工具和必需工具传入 AgentLoop。

### 5.2 停滞和进展模型

- `packages/core/src/runtime/agent-loop-control.ts`
  - 新增目标相关的 `progressFingerprints`。
  - 指纹不包含执行 ID，重复相同输入和相同结果不算新进展。
  - 只有能绑定验收条件的证据、实质变更或恢复推进才刷新进度。
  - 边界续跑要求本段有真实进展，或仍有尚未使用的结构化恢复策略。
- `packages/core/src/runtime/agent-loop.ts`
  - 新增 `execution.no-progress` 编排日志。
  - 记录工具名、连续无进展次数、进度版本和停止原因。

### 5.3 计划合同与证据类型

- `packages/core/src/runtime/plan-contract.ts`
  - `expectedOutputs` 允许为空。
  - 明确其只表示持久文件产物。
- `packages/core/src/tool/types.ts`
- `packages/core/src/store/tool-execution.ts`
  - 运行时证据类型扩展为包含规划、原理图、数据手册、源码、工作区、外部研究、工作区变更和硬件观测。

### 5.4 仲裁后的可信证据晋升

- `packages/core/src/tool/general/task-review.ts`
  - 仅当仲裁结论为 accepted 时，提取通过验收项引用的子任务证据。
  - 以 `task-review:<runId>` 作为生产者写入根任务可观察结果。
  - 未通过或未被 acceptance check 引用的证据不会晋升。

### 5.5 新增完整系统测试

- `packages/core/test/planned-research-system.test.ts`

该测试不是单元测试替身，而是直接经过：

- `handleChat`
- SessionCommand 队列
- AgentLoop
- ModelRouter
- AgentRegistry
- ToolRegistry
- 自动规划
- `task`
- 子 Agent
- 确定性的 `websearch` 适配器
- `task_review`
- SSE
- 持久化仓库和编排日志

测试使用真实用户句子，但用本地确定性 OpenAI-compatible 流服务替代外部模型，确保能够稳定复现编排逻辑。

## 6. 已取得的测试结果

在新增完整系统测试之前，以下定向运行曾通过：

```text
packages/core/test/governance-boundaries.test.ts
packages/core/test/runtime.test.ts
packages/core/test/plan-contract-architecture.test.ts
packages/core/test/multi-agent-invariant-redteam.test.ts
```

当时结果为 `231 pass / 0 fail`。后续又增加了计划合同和证据晋升改动，因此该结果只能作为阶段性证据，必须重新执行。

类型检查在上述后续改动前曾通过，也必须重新执行。

## 7. 最新系统测试失败证据

执行命令：

```powershell
cd H:\Prj\CD041_LUBAN\embedded-agent
bun test packages/core/test/planned-research-system.test.ts
```

2026-07-31 最新结果：

```text
0 pass
1 fail
```

关键计数：

| 阶段 | 次数 |
|---|---:|
| plan 调用 | 1 |
| task 调用 | 19 |
| 子 Agent websearch | 0 |
| task_review | 0 |
| 子 Agent 最终回复 | 0 |
| 根 Agent finalization | 1 |

命令终态：

```text
state = failed
error = 任务未完成：现有恢复策略未形成新的可验证证据；仍有 1 个待办，当前进度已保存
```

日志已经证明：

1. 自动规划成功。
2. 已发布 PlanContract，并进入 execution phase。
3. 根 Agent 发出了 `delegation.requested`。
4. 没有出现 `delegation.contract-created`。
5. 没有出现 `delegation.started`。
6. 没有实际子 Agent 模型请求。
7. 根 Agent 在多个执行段中重复调用 `task`，总计 19 次。
8. 每个执行段内部会因三轮无进展进入 `stalled`，但跨执行段仍重新尝试同一委派，最终失败。

因此当前剩余根因已经收窄到两个相邻边界：

- `task` 在记录 `delegation.requested` 之后、持久化子任务合同之前返回失败。
- 同一结构化委派失败的指纹没有在整个根运行范围内阻止跨段重复执行。

## 8. P0 剩余任务

### P0-1：捕获 task 的真实失败结果

当前系统测试的诊断输出记录了请求计数和编排事件，但 SSE 的普通 `tool-result` 投影没有携带内部错误正文。下一步应从以下任一权威入口读取失败：

1. `ToolExecutionRepo` 中对应 `task` execution 的结构化 result/outcome。
2. 在测试依赖中订阅 AgentLoop 的完整 tool-result 事件。
3. 在测试失败诊断中只输出最后一个唯一 `task` 错误指纹、category、diagnostic.kind 和 nextActions。

不要靠猜测修改 `task.ts`。

验收：第一次 task 失败时，测试输出能明确指出失败发生在计划引用校验、能力预检、租约分配、调度入队还是合同持久化中的哪一步。

### P0-2：修复 task 在合同持久化前失败的原始原因

重点检查顺序：

1. `assertPlanNodeInvocationMatches`
2. `instantiatePlannedTaskContract`
3. `unsupportedTaskEffects`
4. `allocateDelegatedExecutionLease`
5. `taskScheduler.enqueue`
6. `RunContractRepo.create`

修复必须保持下列不变量：

- 计划节点的角色、资源和验收不能由模型改写。
- 子 Agent 必须在让出父任务所有权之前通过能力预检。
- 没有持久合同的子任务不能启动。
- 研究 Agent 不需要 workspace-write 才能提交外部研究证据。
- 主 Agent 仍是唯一面向用户和负责最终验收的 owner。

### P0-3：把失败去重提升为根运行级不变量

目前停滞计数主要按执行段收敛，导致相同 task 失败可在新执行段再次发生。需要：

- 将不可恢复的委派失败指纹持久化到根运行的恢复账本。
- 相同 PlanContract 节点、相同 Agent、相同合同版本、相同失败指纹不得跨段重新执行。
- 只有合同修订、角色变更、资源状态变更或恢复策略变更后才允许再次委派。
- 已知非重试错误不得触发模型“换个说法再调用”。

验收：故意制造同一 task 失败时，全根运行最多一次原始调用；随后由主 Agent选择不同恢复策略或以结构化失败结束，不得出现 19 次重复调用。

### P0-4：让完整系统测试通过

系统测试预期固定为 6 次模型请求：

1. 根 Agent 规划。
2. 根 Agent 委派。
3. 子 Agent 调用 websearch。
4. 子 Agent无工具最终总结。
5. 根 Agent task_review。
6. 根 Agent无工具最终交付。

最终断言：

- 根 SessionCommand = `completed`
- 根 TaskRun = `completed`
- 子任务数量 = 1
- 子任务仲裁 = `accepted`
- 仲裁分数 = 100
- 根目标具备 `external-research` 证据
- SSE 含 execution phase 和 completed done
- 用户收到安全边界明确的最终回复
- 不含 `execution.contract-rejected`

## 9. P1 系统级与压力验证

P0 通过后按顺序执行：

```powershell
# 新增的真实编排系统测试
bun test packages/core/test/planned-research-system.test.ts

# 架构与红队回归
bun test packages/core/test/governance-boundaries.test.ts packages/core/test/runtime.test.ts packages/core/test/plan-contract-architecture.test.ts packages/core/test/multi-agent-invariant-redteam.test.ts

# 类型检查
pnpm typecheck

# 多 Agent 和编排压力测试
pnpm stress:multi-agent
pnpm stress:orchestration

# 全量测试
pnpm test

# 构建验证
pnpm build

# 差异与格式检查
git diff --check
git status --short
```

压力测试必须至少覆盖：

1. 同一会话连续提交两条命令时只允许一个 lane owner。
2. 用户新消息排队，不重复显示、不抢占当前任务。
3. 4 个可并行原子任务能够并行，但同一写资源互斥。
4. 子 Agent 超时后父 Agent 恢复所有权。
5. 子 Agent 提交结果后必须等待主 Agent 仲裁。
6. 模型限流、网络短断和一次空回复可恢复，但不可重复产生相同副作用。
7. SSE 重连不重复创建根任务、用户消息或子任务。
8. 无进展工具调用不能刷新任务生命期。
9. 用户手动后续硬件验证不得阻塞可自动完成的软件任务。
10. 根终态、SSE 终态、右侧任务清单和持久化状态一致。

## 10. P2 文档、提交与发布

在所有 P0/P1 验证通过后：

1. 更新 `docs/main-agent-multi-agent-architecture-analysis-2026-07-23.md`，写入阶段控制面租约、根运行级失败指纹和仲裁证据晋升规则。
2. 删除或压缩系统测试中的超长失败调试输出，只保留可定位字段。
3. 审查当前工作区中与本任务无关的历史修改，禁止覆盖或混入提交。
4. 按架构主题提交代码。
5. 只有全量测试、压力测试和生产构建都通过后才重新打包。
6. 安装新包后，用真实 UI 再执行同一句太阳能逆变请求，核对日志文件、SSE、任务清单和最终回复。

## 11. 接手注意事项

- 当前工作区还有其他未提交功能，例如 Token 热力图、会话意图、模型重试和 UI 改动；它们不全部属于本任务。
- 禁止使用 `git reset --hard`、`git checkout --` 或整体覆盖文件。
- 先使用 `git diff` 精确划分本任务改动。
- 不要通过添加中文关键字触发规划或委派；意图由语义分析和运行时合同决定。
- 不要通过增加 maxSteps、重试次数或超时时间解决无进展循环。
- 不要在系统测试通过前宣称“已修复”“已完成”或生成发布包。
- 太阳能逆变涉及危险市电。测试交付只验证 Agent 编排与概念性安全方案，不应生成可直接照做的高压接线步骤。

## 12. 交付结论

本轮已经完成了生产证据调查、目标架构设计审查和第一阶段代码落地，并建立了覆盖真实 `handleChat/SSE/多 Agent/仲裁` 的系统测试。当前测试证明原有“plan 工具不可见”和“工具活动被误计为进展”的问题已经被架构化处理，但同时发现委派链在 `delegation.requested` 与子任务合同持久化之间仍有失败，而且根运行会跨段重复同一委派。

后续执行者应首先获取第一次 task 失败的结构化结果，然后修复该边界和根运行级失败去重。只有系统测试稳定达到“一次规划、一次委派、一次研究、一次仲裁、一次最终交付”，并通过压力与全量验证后，任务才算真正完成。
