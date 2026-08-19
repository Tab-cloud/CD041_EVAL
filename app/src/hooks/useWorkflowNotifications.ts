import { useCallback, useEffect, useRef, useState } from "react"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { apiFetch } from "../api"
import type { WorkflowRun, WorkflowStatus } from "../components/workflow-types"

const STORAGE_KEY = "eval.workflowNotifications"

export function useWorkflowNotifications() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STORAGE_KEY) === "1")
  const statuses = useRef(new Map<string, WorkflowStatus>())
  const initialized = useRef(false)

  const toggle = useCallback(async () => {
    if (enabled) {
      localStorage.setItem(STORAGE_KEY, "0")
      setEnabled(false)
      return
    }
    let granted = await isPermissionGranted()
    if (!granted) granted = await requestPermission() === "granted"
    localStorage.setItem(STORAGE_KEY, granted ? "1" : "0")
    setEnabled(granted)
  }, [enabled])

  useEffect(() => {
    if (!enabled) { initialized.current = false; statuses.current.clear(); return }
    let active = true
    const poll = async () => {
      try {
        const response = await apiFetch("/api/workflows?limit=100")
        if (!response.ok || !active) return
        const payload = await response.json() as { workflows?: WorkflowRun[] }
        const workflows = payload.workflows ?? []
        if (initialized.current) {
          for (const workflow of workflows) {
            const previous = statuses.current.get(workflow.id)
            if (previous && previous !== workflow.status && ["completed", "failed"].includes(workflow.status)) {
              sendNotification({
                title: workflow.status === "completed" ? "工作流已完成" : "工作流执行失败",
                body: workflow.goal.slice(0, 180),
              })
            }
          }
        }
        statuses.current = new Map(workflows.map((workflow) => [workflow.id, workflow.status]))
        initialized.current = true
      } catch { /* 通知轮询不影响主界面 */ }
    }
    void poll()
    const timer = setInterval(() => void poll(), 10_000)
    return () => { active = false; clearInterval(timer) }
  }, [enabled])

  return { enabled, toggle }
}
