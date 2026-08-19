import { defineTool } from "../define"

export const questionTool = defineTool({
  name: "question",
  description: "向用户提问以澄清需求。在做出技术决策前，先确认用户意图。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "要问用户的问题" },
      options: {
        type: "array", items: { type: "string" },
        description: "可选的答案选项（最多 4 个）",
      },
    },
    required: ["question"],
  },
  async execute({ question, options }: { question: string; options?: string[] }, _ctx) {
    const data: any = { question }
    if (options && options.length) data.options = options.slice(0, 4)
    // AgentLoop 将该结构转换为可恢复的用户交互：挂起当前执行、等待回答，
    // 再把回答作为本次工具结果送回同一个模型上下文。
    return { success: true, data }
  },
  contract: { effects: ["user-interaction"], idempotency: "idempotent", cancellation: "unsupported", progress: { role: "control" } }, permission: "question",
})
