import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"

export interface TaskCompletionEvent {
  taskId: string
  status: string
  message?: string
}

export interface TaskNotificationPlatform {
  backgroundState(): Promise<{ minimized: boolean; visible: boolean }>
  ensurePermission(): Promise<boolean>
  send(input: { title: string; body: string }): void
}

export type TaskNotificationResult =
  | "sent"
  | "ignored-non-terminal"
  | "ignored-duplicate"
  | "ignored-foreground"
  | "ignored-permission"
  | "ignored-unavailable"

const MAX_OBSERVED_TASKS = 500

/**
 * Owns task-terminal notification de-duplication. A task becomes observed
 * when its first authoritative completed state arrives, even if Eval is in
 * the foreground, so an SSE replay cannot create a delayed false reminder.
 */
export class TaskCompletionNotifier {
  private readonly observed = new Set<string>()

  async notify(
    event: TaskCompletionEvent,
    platform: TaskNotificationPlatform,
  ): Promise<TaskNotificationResult> {
    if (event.status !== "completed" || !event.taskId) return "ignored-non-terminal"
    if (this.observed.has(event.taskId)) return "ignored-duplicate"
    this.remember(event.taskId)

    let state: { minimized: boolean; visible: boolean }
    try {
      state = await platform.backgroundState()
    } catch {
      return "ignored-unavailable"
    }
    if (!state.minimized && state.visible) return "ignored-foreground"

    let granted = false
    try {
      granted = await platform.ensurePermission()
    } catch {
      return "ignored-unavailable"
    }
    if (!granted) return "ignored-permission"

    try {
      platform.send({
        title: "Eval 任务已完成",
        body: notificationBody(event.message),
      })
      return "sent"
    } catch {
      return "ignored-unavailable"
    }
  }

  private remember(taskId: string): void {
    this.observed.add(taskId)
    if (this.observed.size <= MAX_OBSERVED_TASKS) return
    const oldest = this.observed.values().next().value
    if (oldest) this.observed.delete(oldest)
  }
}

const notifier = new TaskCompletionNotifier()
let permissionPromise: Promise<boolean> | null = null

export function prepareTaskCompletionNotifications(): Promise<boolean> {
  if (!isTauriRuntime()) return Promise.resolve(false)
  if (!permissionPromise) {
    permissionPromise = (async () => {
      if (await isPermissionGranted()) return true
      return await requestPermission() === "granted"
    })().catch(() => false)
  }
  return permissionPromise
}

export async function notifyTaskCompletion(event: TaskCompletionEvent): Promise<TaskNotificationResult> {
  if (!isTauriRuntime()) return "ignored-unavailable"
  return notifier.notify(event, {
    async backgroundState() {
      const window = getCurrentWindow()
      const [minimized, visible] = await Promise.all([
        window.isMinimized(),
        window.isVisible(),
      ])
      return { minimized, visible }
    },
    ensurePermission: prepareTaskCompletionNotifications,
    send: sendNotification,
  })
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

function notificationBody(message?: string): string {
  const normalized = message?.replace(/\s+/g, " ").trim()
  return normalized ? normalized.slice(0, 180) : "主 Agent 已完成当前任务，点击 Eval 查看结果。"
}
