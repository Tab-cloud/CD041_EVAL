import type { AgentDefinition } from "../agent/types.ts"
import type { AgentRegistry } from "../agent/registry.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import type {
  AgentActivityEvent,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../tool/types.ts"
import {
  captureFileSnapshot,
  ToolExecutionRepo,
  type FileSnapshot,
  type ToolExecutionStatus,
  type ToolExecutionView,
} from "../store/tool-execution.ts"
import { checkpointManager } from "../store/checkpoint.ts"
import type { ExecutionScope } from "./tool-policy.ts"
import {
  evaluateToolAuthorization,
  toolAuthorizationEffects,
  toolInvocationResourceClaims,
} from "./tool-policy.ts"
import { runtimeAccessManager } from "./runtime-access.ts"
import { toolApprovalManager, type ApprovalOutcome } from "./tool-approval.ts"
import { userQuestionManager, type UserQuestionOutcome } from "./user-question.ts"
import {
  buildToolRecoveryHint,
  requestParentApproval,
  requestParentQuestion,
  resolveToolUserInteraction,
  shouldRetryAfterUserInteraction,
} from "./agent-loop-support.ts"
import { assignExecutionTodos } from "./execution-dispatcher.ts"
import { logOrchestrationEvent } from "./orchestration-log.ts"
import {
  deriveToolExecutionSemantics,
  NO_PROGRESS_SEMANTICS,
} from "./tool-execution-semantics.ts"
import type {
  ExecutionController,
  ToolExecutionOutcome,
} from "./agent-loop-control.ts"
import type { AgentLoopInput } from "./agent-loop.ts"
import type { AgentLoopMessage } from "./agent-loop-messages.ts"
import type { LLMEvent } from "./llm-client.ts"
import { taskScheduler } from "./task-scheduler.ts"

export interface PendingToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolExecutionBatch {
  toolResults: Array<{ id: string; name: string; result: unknown; executionId?: string }>
  executionOutcomes: ToolExecutionOutcome[]
  dispatchInstruction: string
  executionDeadline: number
  interrupted: boolean
}

export interface ToolExecutionDependencies {
  input: AgentLoopInput
  agent: AgentDefinition
  step: number
  pendingToolCalls: PendingToolCall[]
  messages: AgentLoopMessage[]
  toolCtx: ToolContext
  permissionContextId: string
  initialScope: ExecutionScope
  resolveVisibleTools: (scope: ExecutionScope) => ToolDefinition[]
  visibleToolNames: Set<string>
  execution: ExecutionController
  executionDeadline: number
  toolRegistry: ToolRegistry
  agentRegistry: AgentRegistry
  pendingStreams: Array<{ target: string; name: string; text: string; type: string }>
  pendingActivities: AgentActivityEvent[]
  pendingNestedEvents: any[]
  notifyStreamSettled: () => void
  waitForStream: () => Promise<void>
}

export async function* executeToolBatch(
  dependencies: ToolExecutionDependencies,
): AsyncGenerator<LLMEvent & { _step?: number }, ToolExecutionBatch> {
  const {
    input,
    agent,
    step,
    pendingToolCalls,
    messages,
    toolCtx,
    permissionContextId,
    initialScope,
    resolveVisibleTools,
    visibleToolNames,
    execution,
    toolRegistry,
    agentRegistry,
    pendingStreams,
    pendingActivities,
    pendingNestedEvents,
    notifyStreamSettled,
    waitForStream,
  } = dependencies
  let executionDeadline = dependencies.executionDeadline
  const toolResults: ToolExecutionBatch["toolResults"] = []
  const executionOutcomes: ToolExecutionOutcome[] = []
  let dispatchInstruction = ""

  if (pendingToolCalls.length > 0) {
    checkpointManager.save({
      sessionId: input.checkpointKey ?? input.sessionId,
      agentId: input.agentId,
      step,
      messages,
      pendingToolCalls: pendingToolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      })),
      planState: null,
    })
  }

  for (const toolCall of pendingToolCalls) {
    if (input.abortSignal?.aborted) {
      execution.interrupt("用户取消了任务")
      return {
        toolResults,
        executionOutcomes,
        dispatchInstruction,
        executionDeadline,
        interrupted: true,
      }
    }
    yield {
      type: "tool-status",
      id: toolCall.id,
      name: toolCall.name,
      status: "running",
      input: toolCall.input,
      _step: step,
    } as any

    let toolResult: { id: string; name: string; result: unknown; executionId?: string }
    let toolExecution: ToolExecutionView | null = null
    let snapshot: FileSnapshot | null = null
    let executionStatus: Exclude<ToolExecutionStatus, "running"> = "failed"
    let executionError = ""
    let rawResult: ToolResult = { success: false, error: "工具尚未执行" }
    try {
      toolExecution = ToolExecutionRepo.start({
        sessionId: input.sessionId,
        runId: input.runId ?? input.sessionId,
        parentRunId: input.parentRunId,
        toolCallId: toolCall.id,
        agentId: input.agentId,
        toolName: toolCall.name,
        toolInput: toolCall.input,
        workingDir: input.workingDir,
      })
      if (execution.hasFailedInvocation(toolCall.name, toolCall.input)) {
        throw new RepeatedInvocationError(toolCall.name)
      }
      const authorizationScope = runtimeAccessManager.getScope(
        permissionContextId,
        initialScope,
      )
      const authorizationTools = resolveVisibleTools(authorizationScope)
      const authorizationToolNames = new Set(
        authorizationTools.map((tool) => tool.name),
      )
      toolCtx.scope = authorizationScope
      const policyAuthorization = evaluateToolAuthorization(
        agent,
        toolRegistry.get(toolCall.name),
        authorizationToolNames,
        authorizationScope,
        toolCall.input,
        input.toolPolicy,
        input.resourceClaims
          ? { workingDir: input.workingDir, resources: input.resourceClaims }
          : undefined,
      )
      const authorization = runtimeAccessManager.resolveAuthorization(
        permissionContextId,
        policyAuthorization,
      )
      let approved = authorization.action === "allow"
      let rejectionReason = authorization.action === "deny"
        ? authorization.reason
        : ""
      let rejectionKind: "user-decision" | "permission" | undefined =
        authorization.action === "deny" ? "permission" : undefined
      if (authorization.action === "ask" && !approved) {
        const interactionStartedAt = Date.now()
        execution.waitForApproval(authorization.reason || "等待用户批准")
        toolCtx.executionGate?.suspendForApproval(
          authorization.reason || "等待用户批准",
        )
        let outcome: ApprovalOutcome
        if (input.runType === "subagent") {
          outcome = await requestParentApproval(input.onSubAgentInteraction, {
            id: toolCall.id,
            sessionId: input.sessionId,
            runId: toolCtx.runId ?? input.sessionId,
            parentRunId: toolCtx.parentRunId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.input,
            reason: authorization.reason,
            target: toolCall.name,
            createdAt: Date.now(),
            expiresAt: toolCtx.executionDeadline ?? Date.now(),
          })
        } else {
          const pending = toolApprovalManager.create({
            sessionId: input.sessionId,
            runId: toolCtx.runId ?? input.sessionId,
            parentRunId: toolCtx.parentRunId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            toolInput: toolCall.input,
            reason: authorization.reason,
            signal: input.abortSignal,
          })
          yield {
            type: "approval-request",
            approval: pending.request,
            _step: step,
          } as any
          outcome = await pending.outcome
          yield {
            type: "approval-resolved",
            approvalId: pending.request.id,
            outcome,
            _step: step,
          } as any
        }
        if (!input.abortSignal?.aborted) {
          await toolCtx.executionGate?.resumeAfterApproval()
          const waitedMs = Math.max(0, Date.now() - interactionStartedAt)
          executionDeadline += waitedMs
          toolCtx.executionDeadline = executionDeadline
          execution.resumeAfterApproval()
        }
        approved = outcome === "approved"
        if (!approved) {
          rejectionKind = outcome === "denied" ? "user-decision" : "permission"
          rejectionReason = outcome === "denied"
            ? "用户拒绝了本次操作"
            : outcome === "expired"
              ? "审批已超时"
              : "审批已取消"
        }
      }
      if (approved) {
        try {
          snapshot = captureFileSnapshot(
            toolCall.name,
            toolCall.input,
            input.workingDir,
          )
        } catch {
          snapshot = null
        }
      }
      if (approved) {
        let retryAfterConfirmation = false
        let confirmationApplied = false
        do {
          toolCtx.toolCallId = toolCall.id
          retryAfterConfirmation = false
          const concreteTool = toolRegistry.get(toolCall.name)
          if (concreteTool) {
            const claims = toolInvocationResourceClaims(
              concreteTool,
              toolCall.input,
              input.workingDir,
            )
            const conflicts = taskScheduler.findResourceConflicts(
              input.runId ?? input.sessionId,
              claims,
            )
            if (conflicts.length > 0) {
              throw new ResourceLeaseConflictError(
                toolCall.name,
                conflicts.map((task) => `${task.id}:${task.status}`),
              )
            }
          }
          let settled = false
          const executionPromise = toolRegistry.execute(
            toolCall.name,
            toolCall.input,
            toolCtx,
          )
          void executionPromise.then(() => {
            settled = true
            notifyStreamSettled()
          }, () => {
            settled = true
            notifyStreamSettled()
          })
          while (!settled) {
            while (pendingNestedEvents.length > 0) {
              yield { ...pendingNestedEvents.shift()!, _step: step } as any
            }
            while (pendingActivities.length > 0) {
              yield {
                type: "agent-activity",
                activity: pendingActivities.shift()!,
                _step: step,
              } as any
            }
            while (pendingStreams.length > 0) {
              const stream = pendingStreams.shift()!
              yield {
                type: "tool-stream",
                target: stream.target,
                name: toolCall.name,
                text: stream.text,
                streamType: stream.type,
                _step: step,
              } as any
            }
            if (!settled) await waitForStream()
          }
          rawResult = await executionPromise
          delete toolCtx.toolCallId
          delete toolCtx.resolvedUserInteraction
          let userInteraction = resolveToolUserInteraction(
            toolCall.name,
            rawResult,
          )
          if (userInteraction
            && confirmationApplied
            && shouldRetryAfterUserInteraction(toolCall.name, rawResult)) {
            userInteraction = null
            rawResult = {
              success: false,
              error: "目标芯片确认已保存，但构建门禁仍未接受该配置。",
              outcome: {
                status: "failed",
                category: "evidence",
                summary: "目标确认状态未能收敛",
                fingerprint: `build:target-confirmation-not-converged:${toolCall.id}`,
                diagnostic: {
                  kind: "target-confirmation-not-converged",
                  evidence: ["用户确认已经由运行时写入，但同一次工具重试仍要求目标确认"],
                  nextActions: [
                    "检查项目根目录解析与 .eval/project.toml 的持久化位置，禁止再次询问用户同一问题",
                  ],
                },
              },
            }
          }
          if (userInteraction) {
            const interactionStartedAt = Date.now()
            execution.waitForApproval("等待用户回答")
            toolCtx.executionGate?.suspendForApproval("等待用户回答")
            let outcome: UserQuestionOutcome
            if (input.runType === "subagent") {
              outcome = await requestParentQuestion(
                input.onSubAgentInteraction,
                {
                  id: toolCall.id,
                  sessionId: input.sessionId,
                  runId: toolCtx.runId ?? input.sessionId,
                  toolCallId: toolCall.id,
                  question: userInteraction.question,
                  options: userInteraction.options,
                  allowCustom: !userInteraction.purpose,
                  createdAt: Date.now(),
                },
              )
            } else {
              const pending = userQuestionManager.create({
                sessionId: input.sessionId,
                runId: toolCtx.runId ?? input.sessionId,
                toolCallId: toolCall.id,
                question: userInteraction.question,
                options: userInteraction.options,
                allowCustom: !userInteraction.purpose,
                signal: input.abortSignal,
              })
              yield {
                type: "question-request",
                question: pending.request,
                _step: step,
              } as any
              outcome = await pending.outcome
              yield {
                type: "question-resolved",
                questionId: pending.request.id,
                _step: step,
              } as any
            }
            if (!input.abortSignal?.aborted) {
              await toolCtx.executionGate?.resumeAfterApproval()
              const waitedMs = Math.max(0, Date.now() - interactionStartedAt)
              executionDeadline += waitedMs
              toolCtx.executionDeadline = executionDeadline
              execution.resumeAfterApproval()
            }
            if (outcome.status === "answered"
              && shouldRetryAfterUserInteraction(toolCall.name, rawResult)) {
              toolCtx.resolvedUserInteraction = {
                toolCallId: toolCall.id,
                type: userInteraction.purpose === "target-family-confirmation"
                  ? "target-family-confirmation"
                  : "target-confirmation",
                answer: outcome.answer,
              }
              confirmationApplied = true
              retryAfterConfirmation = true
            } else {
              rawResult = outcome.status === "answered"
                ? toolCall.name === "question"
                  ? {
                      success: true,
                      data: {
                        question: userInteraction.question,
                        options: userInteraction.options,
                        answer: outcome.answer,
                      },
                    }
                  : {
                      ...rawResult,
                      data: {
                        ...(rawResult.data && typeof rawResult.data === "object"
                          ? rawResult.data
                          : {}),
                        userInteraction: {
                          ...userInteraction,
                          status: "answered",
                          answer: outcome.answer,
                        },
                        userAnswer: outcome.answer,
                      },
                    }
                : {
                    success: false,
                    error: "用户问题已取消",
                    outcome: {
                      status: "cancelled",
                      category: "generic",
                      summary: "用户问题已取消",
                      fingerprint: `question:cancelled:${toolCall.id}`,
                    },
                  }
            }
          }
        } while (retryAfterConfirmation && !input.abortSignal?.aborted)
        delete toolCtx.resolvedUserInteraction
        while (pendingNestedEvents.length > 0) {
          yield { ...pendingNestedEvents.shift()!, _step: step } as any
        }
        while (pendingActivities.length > 0) {
          yield {
            type: "agent-activity",
            activity: pendingActivities.shift()!,
            _step: step,
          } as any
        }
        while (pendingStreams.length > 0) {
          const stream = pendingStreams.shift()!
          yield {
            type: "tool-stream",
            target: stream.target,
            name: toolCall.name,
            text: stream.text,
            streamType: stream.type,
            _step: step,
          } as any
        }
      } else {
        rawResult = {
          success: false,
          error: `工具调用被拒绝: ${rejectionReason}`,
          outcome: {
            status: "failed",
            category: "permission",
            summary: rejectionReason,
            fingerprint: `permission:${toolCall.name}:${rejectionReason}`,
            diagnostic: {
              kind: "permission-boundary",
              evidence: [rejectionReason],
              nextActions: [
                "保留已取得证据并检查是否存在不需要该权限的安全替代方案",
                "若该操作属于原始验收条件且没有替代方案，等待用户授权或决策",
              ],
              retryable: false,
              externalBlocker: {
                kind: rejectionKind ?? "permission",
                reason: rejectionReason,
              },
            },
          },
        }
      }
      if (rawResult.success) {
        executionStatus = "succeeded"
        toolResult = {
          id: toolCall.id,
          name: toolCall.name,
          result: rawResult.data ?? rawResult,
        }
        if (toolCall.name === "todowrite") {
          const updated = execution.updateTodos(rawResult.data)
          const assignment = assignExecutionTodos(
            updated.todos,
            agent.id,
            agentRegistry.list().map((candidate) => candidate.id),
            visibleToolNames.has("task"),
          )
          execution.updateTodos({ todos: assignment.todos })
          dispatchInstruction = assignment.instruction ?? ""
          logOrchestrationEvent({
            sessionId: input.sessionId,
            runId: input.runId ?? input.sessionId,
            parentRunId: input.parentRunId,
            agentId: agent.id,
            eventType: "root.tasks-published",
            message: "主 Agent 发布了有序执行清单",
            data: {
              runType: input.runType,
              count: assignment.todos.length,
              tasks: assignment.todos.map((todo, index) => ({
                order: index + 1,
                content: todo.content.slice(0, 240),
                status: todo.status,
                priority: todo.priority,
                assignee: todo.assignee,
                acceptance: todo.acceptance?.slice(0, 240),
              })),
              delegationInstructionIssued: Boolean(dispatchInstruction),
            },
          })
        }
        toolResults.push(toolResult)
      } else {
        executionStatus = approved ? "failed" : "denied"
        executionError = rawResult.error ?? "工具执行失败"
        toolResult = {
          id: toolCall.id,
          name: toolCall.name,
          result: {
            error: rawResult.error,
            details: rawResult.data,
            diagnostic: rawResult.outcome?.diagnostic,
            recoveryHint: approved
              ? buildToolRecoveryHint(toolCall.name, authorizationToolNames)
              : "本次调用未获授权。不得通过 shell、Python 或其他工具绕过审批；可选择只读方案，或向用户说明需要的授权。",
          },
        }
        toolResults.push(toolResult)
      }
    } catch (error: any) {
      executionStatus = "failed"
      const repeatedInvocation = error instanceof RepeatedInvocationError
      const resourceConflict = error instanceof ResourceLeaseConflictError
      const resourceConflictError = resourceConflict ? error : undefined
      executionError = repeatedInvocation
        ? error.message
        : resourceConflict
          ? error.message
        : `工具执行异常: ${error.message}`
      rawResult = {
        success: false,
        error: executionError,
        outcome: {
          status: "failed",
          category: "generic",
          summary: executionError,
          fingerprint: repeatedInvocation
            ? `repeated-invocation:${toolCall.name}`
            : resourceConflict
              ? `resource-lease-conflict:${toolCall.name}:${resourceConflictError!.conflicts.join(",")}`
            : `${toolCall.name}:${executionError}`,
          diagnostic: repeatedInvocation
            ? {
                kind: "repeated-invocation",
                evidence: ["相同工具、语义输入和进展版本已经失败"],
                nextActions: ["选择尚未尝试的恢复策略；不得再次提交相同调用"],
                retryable: false,
              }
            : resourceConflict
              ? {
                  kind: "resource-lease-conflict",
                  evidence: resourceConflictError!.conflicts,
                  nextActions: [
                    "等待持有冲突资源的子任务完成或完成安全清理",
                    "不得绕过资源租约或并发覆盖子 Agent 的工作区",
                  ],
                  retryable: true,
                }
              : undefined,
        },
      }
      toolResult = {
        id: toolCall.id,
        name: toolCall.name,
        result: {
          error: executionError,
          recoveryHint: buildToolRecoveryHint(
            toolCall.name,
            visibleToolNames,
          ),
        },
      }
      toolResults.push(toolResult)
    }
    if (toolExecution) {
      toolExecution = ToolExecutionRepo.finish(toolExecution.id, {
        status: executionStatus,
        result: {
          payload: toolResult.result,
          runtimeEvidence: rawResult.outcome?.evidence ?? [],
          runtimeOutcome: rawResult.outcome,
        },
        error: executionError || undefined,
        snapshot,
      })
      if (!toolExecution) {
        throw new Error(`工具审计记录丢失: ${toolCall.name}`)
      }
      toolResult.executionId = toolExecution.id
    }
    const executedTool = toolRegistry.get(toolCall.name)
    executionOutcomes.push({
      name: toolCall.name,
      result: rawResult,
      input: toolCall.input,
      executionId: toolExecution?.id,
      toolEffects: executedTool
        ? [...toolAuthorizationEffects(executedTool, toolCall.input)]
        : [],
      semantics: executedTool
        ? deriveToolExecutionSemantics(executedTool, toolCall.input, rawResult)
        : NO_PROGRESS_SEMANTICS,
    })

    yield {
      type: "tool-status",
      id: toolCall.id,
      name: toolCall.name,
      status: executionStatus,
      _step: step,
    } as any
    yield {
      type: "tool-result",
      id: toolCall.id,
      name: toolCall.name,
      result: toolResult.result,
      _step: step,
    } as any
    if (toolExecution) {
      yield {
        type: "tool-execution",
        execution: toolExecution,
        _step: step,
      } as any
    }

    while (pendingStreams.length > 0) {
      const stream = pendingStreams.shift()!
      yield {
        type: "tool-stream",
        target: stream.target,
        name: toolCall.name,
        text: stream.text,
        streamType: stream.type,
        _step: step,
      } as any
    }
    while (pendingActivities.length > 0) {
      yield {
        type: "agent-activity",
        activity: pendingActivities.shift()!,
        _step: step,
      } as any
    }
  }

  return {
    toolResults,
    executionOutcomes,
    dispatchInstruction,
    executionDeadline,
    interrupted: false,
  }
}

class RepeatedInvocationError extends Error {
  constructor(toolName: string) {
    super(`已拒绝原样重复失败调用: ${toolName}`)
    this.name = "RepeatedInvocationError"
  }
}

class ResourceLeaseConflictError extends Error {
  constructor(
    toolName: string,
    readonly conflicts: string[],
  ) {
    super(`工具 ${toolName} 的工作区目标仍由其他运行持有租约：${conflicts.join(", ")}`)
    this.name = "ResourceLeaseConflictError"
  }
}
