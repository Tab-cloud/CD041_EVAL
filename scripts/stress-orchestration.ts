import { performance } from "node:perf_hooks"
import { OrchestrationLogRepo } from "../packages/core/src/store/orchestration-log.ts"
import { RunEventRepo } from "../packages/core/src/store/run-event.ts"
import { TaskRunRepo } from "../packages/core/src/store/task-run.ts"
import { TaskScheduler } from "../packages/core/src/runtime/task-scheduler.ts"
import { ExecutionController } from "../packages/core/src/runtime/agent-loop-control.ts"
import { resolveConversationObjectiveProposal } from "../packages/core/src/runtime/conversation-objective.ts"
import { parseConversationTurnIntent } from "../packages/core/src/runtime/conversation-turn-intent.ts"
import { MainAgentDeliveryLedger } from "../packages/core/src/runtime/main-agent-delivery.ts"
import { getDb } from "../packages/core/src/store/database.ts"

if (!process.env.EVAL_DATA_DIR?.includes("eval-agent-stress-")) {
  throw new Error("拒绝压测生产数据库：请把 EVAL_DATA_DIR 指向名称含 eval-agent-stress- 的临时目录")
}

const sessionId = `stress-${Date.now()}`
const logCount = 8_000

const logStarted = performance.now()
for (let index = 0; index < logCount; index++) {
  OrchestrationLogRepo.insert({
    sessionId,
    runId: `${sessionId}-run`,
    eventType: "stress.transition",
    level: "info",
    message: "stress",
    data: { index },
  })
}
const logElapsedMs = performance.now() - logStarted

for (let index = 0; index < 150; index++) {
  TaskRunRepo.create({
    id: `${sessionId}-task-${index}`,
    sessionId,
    agentId: "stress",
    priority: 1,
    status: "queued",
    message: "active",
    workingDir: ".",
    type: "background",
    createdAt: Date.now() + index,
  })
}
const activeRetained = TaskRunRepo.listBySession(sessionId, 500).length

const eventRunId = `${sessionId}-large-event`
RunEventRepo.append(eventRunId, sessionId, "tool-result", { output: "x".repeat(300_000), status: "succeeded" })
const payload = RunEventRepo.listAfter(eventRunId)[0]?.payload as Record<string, any>

const scheduler = new TaskScheduler(1, 10, {
  create: () => undefined,
  update: (task) => {
    if (task.status === "completed") throw new Error("injected-commit-failure")
  },
  markUnfinishedInterrupted: () => 0,
})
const task = scheduler.enqueue({
  sessionId, agentId: "stress", priority: 1, type: "chat", message: "fault", workingDir: ".",
})
let rollbackObserved = false
try {
  scheduler.completeTask(task.id, "done")
} catch {
  rollbackObserved = task.status === "running" && scheduler.getStats().running === 1
}

const longExecution = new ExecutionController(1, 1, 60_000, 3, {
  objective: { content: "long-running stress objective", acceptance: "all evidence collected" },
})
let productiveContinuation = true
for (let index = 0; index < 100; index++) {
  longExecution.observe([{
    name: "read",
    input: { paths: [`src/part-${index}.c`] },
    result: {
      success: true,
      outcome: {
        status: "succeeded",
        category: "file-system",
        summary: `inspected part ${index}`,
      },
    },
    semantics: {
      mutation: false,
      verification: true,
      mutationTargets: [],
      verificationTargets: [`src/part-${index}.c`],
      globalVerification: false,
    },
  }])
  if (!longExecution.canContinueAfterBoundary(1)) {
    productiveContinuation = false
    break
  }
  longExecution.continueAfterBoundary()
}

const conversationCycles = 5_000
let inheritedObjectives = 0
let structuredIntents = 0
const deliveryLedger = new MainAgentDeliveryLedger()
for (let index = 0; index < conversationCycles; index++) {
  const sourceId = `proposal-${index}`
  const objectiveId = `objective-${index}`
  const objective = resolveConversationObjectiveProposal({
    sourceMessageId: sourceId,
    content: [
      `执行目标 ${index}，当前真正待办：`,
      "1. 读取构建定义",
      "2. 修改目标文件",
      "3. 执行编译验证",
      "4. 生成验收报告",
      "要我现在执行这 4 项吗？",
    ].join("\n"),
    taskCount: 4,
    tasks: ["读取构建定义", "修改目标文件", "执行编译验证", "生成验收报告"],
  }, 4)
  const intent = parseConversationTurnIntent(JSON.stringify({
    mode: "execute",
    executionTarget: "open-objective",
    queryTarget: "none",
    continuationMode: "control-only",
    confidence: 0.99,
    objectiveId,
  }))
  if (objective.confirmation
    && objective.sourceMessageId === sourceId
    && objective.tasks?.length === 4
    && objective.tasks[0] === "读取构建定义"
    && objective.effectiveMessage.includes("生成验收报告")) {
    inheritedObjectives++
  }
  if (intent.kind === "resume-objective" && intent.objectiveId === objectiveId) {
    structuredIntents++
  }

  // Exercise both provider event orders. A native tool call invalidates all
  // prose from that round as public delivery even if text arrived first.
  if (index % 2 === 0) {
    deliveryLedger.observeText(0, index, `progress-before-tool-${index}`)
    deliveryLedger.observeToolCall(0, index)
  } else {
    deliveryLedger.observeToolCall(0, index)
    deliveryLedger.observeText(0, index, `progress-after-tool-${index}`)
  }
  // Provider finish seals the round. Tool rounds must remain excluded in
  // either text/tool event order.
  deliveryLedger.finishRound(0, index)
}
deliveryLedger.observeText(1, 0, "final-delivery")
deliveryLedger.finishRound(1, 0)
const deliveryIsolation = deliveryLedger.delivery() === "final-delivery"

const result = {
  orchestrationLogs: {
    count: logCount,
    elapsedMs: Math.round(logElapsedMs),
    transitionsPerSecond: Math.round(logCount / (logElapsedMs / 1_000)),
  },
  activeTaskRetention: { expected: 150, actual: activeRetained },
  largeEventReplay: {
    valid: payload?.status === "succeeded",
    truncatedSafely: payload?._persistence?.truncated === true,
  },
  persistenceFaultRollback: rollbackObserved,
  productiveLongExecution: {
    continued: productiveContinuation,
    segments: longExecution.snapshot().continuations,
    stagnantSegments: longExecution.snapshot().stagnantSegments,
  },
  conversationContinuation: {
    cycles: conversationCycles,
    inheritedObjectives,
    structuredIntents,
    deliveryIsolation,
  },
}
console.log(JSON.stringify(result, null, 2))

getDb().close()

if (
  activeRetained !== 150
  || !result.largeEventReplay.valid
  || !result.largeEventReplay.truncatedSafely
  || !rollbackObserved
  || !productiveContinuation
  || inheritedObjectives !== conversationCycles
  || structuredIntents !== conversationCycles
  || !deliveryIsolation
) {
  process.exitCode = 1
}
