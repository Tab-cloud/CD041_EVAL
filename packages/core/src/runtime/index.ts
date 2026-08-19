/**
 * Eval Runtime 启动入口
 */
import { ToolRegistry } from "../tool/registry.ts"
import { AgentRegistry } from "../agent/registry.ts"
import { ModelRouter } from "../model-router/index.ts"
import { AgentLoop } from "./agent-loop.ts"
import { inject, handleRequest } from "./server.ts"
import { AgentOrchestrator } from "./orchestrator.ts"
import { configStore } from "./config-store.ts"
import { getDb, closeDb } from "../store/database.ts"
import { EMBEDDED_TOOLS } from "../tool/tools-index.ts"
import { HIDDEN_AGENTS } from "../agent/definitions/all.ts"
import { taskScheduler } from "./task-scheduler.ts"
import { applyCustomAgents } from "../agent/custom-agents.ts"
import { mcpManager } from "../mcp/manager.ts"
import { WorkflowEngine } from "./workflow-engine.ts"
import { hydrateRuntimeCredentials } from "./credential-bootstrap.ts"
import { ToolExecutionRepo } from "../store/tool-execution.ts"
import { WorkflowWebhookRepo } from "../store/workflow-webhook.ts"
import { assertDesktopProtocol } from "./runtime-protocol.ts"
import { assertRuntimeCapabilities } from "./runtime-capability-audit.ts"
import { ToolApprovalRecordRepo } from "../store/tool-approval-record.ts"
import { ModelAttemptRepo } from "../store/model-attempt.ts"
import {
  SESSION_COMMAND_PROCESS_EPOCH,
} from "./session-command-queue.ts"
import {
  startRuntimeLeadership,
  stopRuntimeLeadership,
} from "./runtime-leadership.ts"
import { stopRuntimeOwnerLease } from "./runtime-owner-lease.ts"
import { evaluateModelExecutionReadiness } from "./model-execution-readiness.ts"

const PORT = parseInt(process.env.PORT ?? "4096", 10)
const HOST = process.env.HOST ?? "127.0.0.1"
try {
  if (process.env.EVAL_ALLOW_STANDALONE !== "1") {
    assertDesktopProtocol(process.env.EVAL_DESKTOP_PROTOCOL_VERSION)
  }
} catch (error) {
  console.error(`[ERR] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(78)
}

if (!process.env.EVAL_AGENT_TOKEN && process.env.EVAL_ALLOW_UNAUTHENTICATED !== "1") {
  console.error("[ERR] EVAL_AGENT_TOKEN 未设置，拒绝启动无鉴权服务")
  process.exit(1)
}

process.on("uncaughtException", (err) => console.error("[ERR]", err.message))
process.on("unhandledRejection", (r) => console.error("[ERR] unhandledRejection:", String(r)))

function shutdown(s: string, exitCode = 0) {
  console.log(`\n[stop] ${s}`)
  try { mcpManager.close() } catch {}
  try { workflowEngine?.close() } catch {}
  try { stopRuntimeLeadership(SESSION_COMMAND_PROCESS_EPOCH, true) } catch {}
  try { stopRuntimeOwnerLease(SESSION_COMMAND_PROCESS_EPOCH, true) } catch {}
  try { closeDb() } catch {}
  process.exit(exitCode)
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

let workflowEngine: WorkflowEngine | null = null

function bootstrap() {
  getDb()
  if (!startRuntimeLeadership(SESSION_COMMAND_PROCESS_EPOCH, () => {
    shutdown("runtime leadership lost", 75)
  })) {
    throw new Error("已有活动的 Eval 控制平面实例，当前进程拒绝并行调度")
  }
  const interrupted = taskScheduler.recoverInterrupted()
  const interruptedTools = ToolExecutionRepo.recoverInterrupted()
  const interruptedWebhooks = WorkflowWebhookRepo.recoverInterrupted()
  const interruptedApprovals = ToolApprovalRecordRepo.recoverInterrupted()
  const interruptedModelAttempts = ModelAttemptRepo.recoverInterrupted()
  console.log("[OK] SQLite + RAG + Checkpoint 已就绪")
  if (interrupted > 0) console.log(`[INFO] 已标记 ${interrupted} 个中断任务，等待用户决定是否恢复`)
  if (interruptedTools > 0) console.log(`[INFO] 已标记 ${interruptedTools} 个中断工具调用`)
  if (interruptedWebhooks > 0) console.log(`[INFO] 已标记 ${interruptedWebhooks} 个中断 Webhook 投递`)
  if (interruptedApprovals > 0) console.log(`[INFO] 已取消 ${interruptedApprovals} 个失去执行协程的审批请求`)
  if (interruptedModelAttempts > 0) console.log(`[INFO] 已关闭 ${interruptedModelAttempts} 个中断的模型调用记录`)

  const toolReg = new ToolRegistry()
  toolReg.registerAll(EMBEDDED_TOOLS)
  console.log(`[OK] 工具: ${EMBEDDED_TOOLS.length} 个`)

  const agentReg = new AgentRegistry()
  agentReg.registerAll(HIDDEN_AGENTS)
  applyCustomAgents(agentReg, toolReg)
  const capabilityAudit = assertRuntimeCapabilities(agentReg, toolReg)
  for (const warning of capabilityAudit.warnings) console.warn(`[WARN] ${warning}`)
  console.log(`[OK] Agent: ${agentReg.list().length} 个`)

  const models = configStore.load()
  const modelRouter = new ModelRouter(models, { eligibility: evaluateModelExecutionReadiness })
  console.log(`[OK] 模型: ${models.length} 个`)
  for (const m of models) {
    // 不输出密钥前缀/长度，仅指示是否已配置
    const keyHint = m.apiKey ? "已配置" : "(空)"
    console.log(`   - [${m.provider}] ${m.name}  modelId="${m.modelId}"  baseUrl="${m.baseUrl || "(默认)"}"  apiKey=${keyHint}`)
  }

  const loop = new AgentLoop({ toolRegistry: toolReg, agentRegistry: agentReg, modelRouter })
  // 使用动态注册表，运行中新增的自定义 Agent 也能立即参与自动路由。
  const orchestrator = new AgentOrchestrator(() => agentReg.list())
  workflowEngine = new WorkflowEngine(loop, agentReg, modelRouter, toolReg)
  const interruptedWorkflows = workflowEngine.recoverInterrupted()
  workflowEngine.startSchedulePolling()
  if (interruptedWorkflows > 0) console.log(`[INFO] 已暂停 ${interruptedWorkflows} 个中断工作流，等待用户恢复`)
  inject({ agentLoop: loop, toolRegistry: toolReg, agentRegistry: agentReg, modelRouter, orchestrator, workflowEngine })
  mcpManager.attach(toolReg)
}

await hydrateRuntimeCredentials()
try {
  bootstrap()
} catch (error) {
  console.error(`[ERR] ${error instanceof Error ? error.message : String(error)}`)
  try { stopRuntimeOwnerLease(SESSION_COMMAND_PROCESS_EPOCH, true) } catch {}
  try { closeDb() } catch {}
  process.exit(75)
}

try {
  Bun.serve({ hostname: HOST, port: PORT, maxRequestBodySize: 64 * 1024 * 1024, fetch: handleRequest })
} catch (err: any) {
  if (err.code === "EADDRINUSE") {
    console.error(`[ERR] 端口 ${PORT} 被占用`)
    shutdown("port already in use", 1)
  }
  throw err
}

console.log(`\nEval http://localhost:${PORT}  (bound ${HOST})\n`)
