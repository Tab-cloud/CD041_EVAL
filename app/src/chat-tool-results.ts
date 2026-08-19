import type { Dispatch } from "react"
import type { AppAction } from "./store"

interface ToolResultContext {
  dispatch: Dispatch<AppAction>
}

export async function applyToolResult(data: any, context: ToolResultContext): Promise<void> {
  const { dispatch } = context
  if (data.name === "todowrite" && data.result?.todos) {
    dispatch({ type: "SET_TODOS", todos: data.result.todos })
    dispatch({
      type: "SET_FOLLOWUPS",
      followups: Array.isArray(data.result.followups) ? data.result.followups : [],
    })
  }
  if (data.name === "plan" && data.result?.title && data.result?.content) {
    dispatch({
      type: "SET_PLAN",
      plan: {
        title: data.result.title,
        content: data.result.content,
        options: Array.isArray(data.result.options) ? data.result.options : undefined,
        status: "showing",
        timestamp: Date.now(),
      },
    })
  }
  if (data.result?.error) {
    const id = data.id ? `log-${data.id}` : `log-active-${data.name || "tool"}`
    dispatch({ type: "UPDATE_WORK_LOG", id, updates: { status: "error", error: String(data.result.error) } })
  }
}
