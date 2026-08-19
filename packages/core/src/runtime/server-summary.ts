/**
 * server-summary.ts — 对话摘要生成
 */
import { llmClient } from "./llm-client"
import { configStore } from "./config-store"
import type { ModelRouter } from "../model-router/index"
import type { ModelConfig } from "../model-router/types.ts"

async function collectSummary(model: ModelConfig, system: string, transcript: string): Promise<string | null> {
  const collected: string[] = []
  try {
    for await (const ev of llmClient.stream({
      model,
      system,
      messages: [{ role: "user", content: transcript }],
      maxSteps: 1,
      thinkingEnabled: false,
    })) {
      if (ev.type === "text-delta") collected.push(ev.text)
      if (ev.type === "error") return null
      if (ev.type === "finish") break
    }
  } catch {
    return null
  }
  return collected.join("").trim() || null
}

export async function summarizeTranscript(
  transcript: string,
  modelRouter: ModelRouter | null,
): Promise<string> {
  const truncated = transcript.length > 8000 ? transcript.slice(0, 8000) + "\n...(已截断)" : transcript
  const models = modelRouter?.list ?? configStore.load()
  const model = models.find(m => m.enabled) ?? models[0]
  if (!model || !model.apiKey) return "归档摘要（未配置 API Key，原文已保留）"

  const summary = await collectSummary(model, `你是知识管理助手。请阅读对话记录，用中文提取以下信息：
1. **核心问题/需求**（1-2 句）
2. **关键技术决策**（列表）
3. **代码片段/配置**（如有，保留关键部分）
4. **结论/行动项**（列表）
输出一个简洁的结构化摘要，控制在 300 字以内。`, truncated)
  return summary || "归档摘要生成失败，原文已保留。"
}

/** 为继续对话生成可持久化的上下文摘要；失败时返回 null，由调用方执行安全摘录兜底。 */
export async function summarizeContextTranscript(transcript: string, model: ModelConfig): Promise<string | null> {
  return collectSummary(model, `你是长期运行 AI Agent 的上下文压缩器。请把已有摘要和新增对话合并为一份可继续执行任务的中文结构化记忆。

必须保留：
1. 用户的明确目标、约束、偏好和尚未完成的要求
2. 已完成操作及其真实结果，不得把计划写成已完成
3. 关键技术决策、文件路径、命令、配置值、错误和验证结果
4. 当前项目状态、未解决问题和下一步行动
5. Agent 分工、用户批准或拒绝的决定

删除寒暄、重复说明和已经失效的过程噪声。禁止虚构。输出 Markdown 小标题和短列表，控制在 1200 个中文字符以内。`, transcript)
}
