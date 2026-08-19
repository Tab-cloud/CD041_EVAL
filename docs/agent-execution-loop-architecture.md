# Eval 轻量 Agent 执行循环架构

> 当前实现复核：2026-08-09
>
> 本文是 `embedded-agent` 当前执行架构的权威说明。旧的 Claim、评分验收、
> `task_review`、`waiting-review` 和 `revision-required` 流程已经下线，不属于兼容边界。

## 1. 设计结论

Eval 采用与 OpenCode/Codex 相同方向的轻量模型循环：模型负责理解问题、选择工具和形成最终回答；
运行时负责工具事务、权限、安全、持久化、取消与真实故障恢复。普通模型完成信号就是当前回合的完成
边界，Todo、证据和验收元数据不能强迫模型继续生成，也不能把正常回答改判为失败。

参考实现：

- OpenCode：`../opencode-dev/packages/opencode/src/session/prompt.ts` 和
  `../opencode-dev/packages/opencode/src/session/processor.ts`；
- Codex：[`protocol_v1.md`](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md)
  与 [`app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)。

## 2. 职责分层

### 2.1 会话控制面

- 每个会话只有一个稳定的 `main-agent` owner；模型路由或专业角色不能替换会话 owner。
- 主 Agent 权限高于子 Agent，但仍受用户授权、工作区范围和安全策略约束。
- 用户命令先进入 durable FIFO，再绑定根 TaskRun；SSE 只负责展示和重连，不拥有执行。
- `ownerEpoch + ownerToken` 只用于命令领取和进程 fencing，这里的 claim 是队列租约术语，
  与已经删除的验收 Claim 工具无关。

### 2.2 模型回合循环

`LightweightTurnLoopPolicy` 只有三个普通决策：

1. 模型返回原生工具调用：执行工具，把真实结果追加到消息历史，再进入下一回合；
2. 模型因输出长度中止：追加续写提示，继续同一回答；
3. 模型正常完成且没有工具调用：完成当前回合。

计划或恢复协议是显式阶段合同，可要求 `plan` 或特定恢复工具。除此之外，运行时不会因为存在 Todo、
证据缺口、未满足的 acceptance 元数据或“正在处理”等措辞强制工具调用或追加模型回合。

模型服务的网络错误、限流、额度和临时故障由 transport/retry/fallback 层处理，不由完成判断层处理。

### 2.3 结果与诊断元数据

工具结果可以生成 artifact、evidence、未解决事项和验证信息。这些信息用于：

- 给下一模型回合提供真实上下文；
- 支持诊断、历史恢复、UI 展示和最终交付清单；
- 在明确的安全或领域阶段执行确定性检查。

这些元数据不拥有普通回合的完成权。旧的加权评分、Claim Registry、Acceptance Gate 和
模型措辞验收已经删除。

## 3. 子任务直接结算

子 Agent 返回一个结构化 `TaskResult` 后，`TaskSettlementService` 在一次持久化事务中完成：

- 保存 TaskResult；
- 将 TaskRun 标为 `completed`；
- 将 RunGraph 节点标为 `accepted`；
- 提交对应 workspace revision/ChangeSet；
- 记录 `node-settled` 事件。

artifact、evidence 和 unresolved 项保留在结果中供主 Agent判断，但不会进入第二个评分/评审状态机。
因此不存在 `task_review`、`waiting-review`、`revision-required` 或固定分数阈值。

## 4. DAG 冗余与失败隔离

`delegate_dag` 使用依赖关系隔离失败：

- 节点失败时，只跳过依赖该节点的后继；
- 与失败节点无依赖的兄弟节点继续执行；
- 完成后把 succeeded、failed、skipped 的结构化部分结果交回主 Agent；
- 主 Agent可根据任务语义选择直接使用部分结果、缩小范围重派或亲自接管；
- 只有用户/父任务取消才停止整个 DAG，并等待真实 Worker 退出。

这使冗余策略成为通用机制，而不是针对固定问题的补丁。

## 5. 安全隔离不是验收门

`safety-quarantine` 只在无法证明回滚或 Worker 退出时使用。它保留冲突资源，避免另一个任务在未知
写入状态上继续工作。安全隔离恢复后才能释放资源，但不会对正常成功结果进行评分或复核。

审批、硬件接入、用户选择等真实外部条件仍可让任务进入显式等待；网络或模型临时错误优先走有界
重试与备用模型。安全状态和模型完成状态是两个独立维度。

## 6. 权限与公开边界

- 只有 `runType=root + agentId=main-agent` 可以调用 `task` 和 `delegate_dag`；
- 子 Agent 不能创建同级或下级 Agent，必须把结果返回主 Agent；
- 子 Agent 的原始身份、提示、工具参数和内部日志不进入公共 SSE；
- 主 Agent 对用户交付，子 Agent 只提供结构化结果；
- 内置编译仍只支持 ESP 家族，其他 MCU 可读资料、设计和写代码，但不能绕过编译边界。

## 7. 持久化与测试隔离

生产数据目录由 `EVAL_DATA_DIR` 决定。测试目录不能只用 PID 命名，因为 Windows 会复用 PID 并可能
重新打开旧 schema 数据库；测试默认目录同时包含 PID 和启动时间。本项目验收时显式把
`EVAL_DATA_DIR` 指向 `D:\eval` 下的独立目录，避免接触生产库和 C 盘测试文件。

## 8. 当前回归证据

2026-08-09 在独立 D 盘测试库完成：

- Core：514/514 通过；
- App：105/105 通过；
- TypeScript workspace typecheck：通过；
- App production build：通过；
- 定向轻量循环/多 Agent 架构回归：280/280 通过。

源程序 Computer Use、文件读写和真实 MiniMax 模型验收仍是打包前独立门槛；没有完成这些 UI 验收时
不得打包。
