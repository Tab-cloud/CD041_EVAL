import { describe, expect, test } from "bun:test"
import {
  TaskCompletionNotifier,
  type TaskNotificationPlatform,
} from "../src/task-completion-notification"

function platform(input: {
  minimized?: boolean
  visible?: boolean
  granted?: boolean
  sent: Array<{ title: string; body: string }>
}): TaskNotificationPlatform {
  return {
    async backgroundState() {
      return {
        minimized: input.minimized ?? false,
        visible: input.visible ?? true,
      }
    },
    async ensurePermission() {
      return input.granted ?? true
    },
    send(notification) {
      input.sent.push(notification)
    },
  }
}

describe("task completion desktop notification", () => {
  test("sends one notification when Eval is minimized", async () => {
    const notifier = new TaskCompletionNotifier()
    const sent: Array<{ title: string; body: string }> = []
    const host = platform({ minimized: true, visible: true, sent })

    expect(await notifier.notify({
      taskId: "task-1",
      status: "completed",
      message: "ECG 代码审查完成",
    }, host)).toBe("sent")
    expect(sent).toEqual([{
      title: "Eval 任务已完成",
      body: "ECG 代码审查完成",
    }])
    expect(await notifier.notify({
      taskId: "task-1",
      status: "completed",
    }, host)).toBe("ignored-duplicate")
    expect(sent).toHaveLength(1)
  })

  test("hidden Eval is treated as background", async () => {
    const notifier = new TaskCompletionNotifier()
    const sent: Array<{ title: string; body: string }> = []
    expect(await notifier.notify({
      taskId: "task-hidden",
      status: "completed",
    }, platform({ minimized: false, visible: false, sent }))).toBe("sent")
    expect(sent).toHaveLength(1)
  })

  test("foreground completion is observed without a delayed replay notification", async () => {
    const notifier = new TaskCompletionNotifier()
    const sent: Array<{ title: string; body: string }> = []
    expect(await notifier.notify({
      taskId: "task-visible",
      status: "completed",
    }, platform({ minimized: false, visible: true, sent }))).toBe("ignored-foreground")
    expect(await notifier.notify({
      taskId: "task-visible",
      status: "completed",
    }, platform({ minimized: true, visible: true, sent }))).toBe("ignored-duplicate")
    expect(sent).toHaveLength(0)
  })

  test("non-completed states and denied permission never notify", async () => {
    const notifier = new TaskCompletionNotifier()
    const sent: Array<{ title: string; body: string }> = []
    expect(await notifier.notify({
      taskId: "task-running",
      status: "running",
    }, platform({ minimized: true, visible: true, sent }))).toBe("ignored-non-terminal")
    expect(await notifier.notify({
      taskId: "task-denied",
      status: "completed",
    }, platform({ minimized: true, visible: true, granted: false, sent }))).toBe("ignored-permission")
    expect(sent).toHaveLength(0)
  })
})
