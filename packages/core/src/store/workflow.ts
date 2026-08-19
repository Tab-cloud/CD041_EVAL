import { randomUUID } from "node:crypto"
import { getDb } from "./database"
import type { ResourceClaims } from "../runtime/run-contract.ts"

export type WorkflowStatus = "planned" | "running" | "pausing" | "cancelling" | "paused" | "completed" | "failed" | "cancelled"
export type WorkflowNodeStatus = "pending" | "queued" | "running" | "safety-quarantine" | "completed" | "failed" | "skipped" | "waiting-human" | "paused" | "cancelled"
export type WorkflowFrequency = "once" | "interval"
export type WorkflowConditionOperator = "contains" | "not-contains" | "equals"

export interface WorkflowNodeCondition {
  nodeId: string
  operator: WorkflowConditionOperator
  value: string
}

export interface WorkflowFailurePolicy {
  maxRetries: number
  delaySeconds: number
  /** fail-fast aborts active siblings; continue lets independent branches join. */
  siblingFailure?: "fail-fast" | "continue"
}

interface WorkflowRunRow {
  id: string; session_id: string; template_id: string; goal: string; working_dir: string
  status: WorkflowStatus; current_node_id: string | null; report: string | null
  failure_policy: string
  created_at: number; started_at: number | null; completed_at: number | null; updated_at: number
}

interface WorkflowNodeRow {
  id: string; workflow_id: string; ordinal: number; title: string; agent_id: string; prompt: string
  status: WorkflowNodeStatus; depends_on: string; result: string | null; error: string | null
  condition: string
  resource_claims: string
  attempt: number; task_run_id: string | null; started_at: number | null; completed_at: number | null; updated_at: number
}

interface WorkflowScheduleRow {
  id: string; name: string; session_id: string; template_id: string; goal: string; working_dir: string
  frequency: WorkflowFrequency; interval_minutes: number | null; next_run_at: number; enabled: number
  last_run_at: number | null; last_workflow_id: string | null; created_at: number; updated_at: number
}

export interface WorkflowNodeView {
  id: string; workflowId: string; ordinal: number; title: string; agentId: string; prompt: string
  status: WorkflowNodeStatus; dependsOn: string[]; result?: string; error?: string
  condition?: WorkflowNodeCondition
  resourceClaims: ResourceClaims
  attempt: number; taskRunId?: string; startedAt?: number; completedAt?: number; updatedAt: number
}

export interface WorkflowRunView {
  id: string; sessionId: string; templateId: string; goal: string; workingDir: string
  status: WorkflowStatus; currentNodeId?: string; report?: string
  failurePolicy: WorkflowFailurePolicy
  createdAt: number; startedAt?: number; completedAt?: number; updatedAt: number
  nodes: WorkflowNodeView[]
}

export interface WorkflowScheduleView {
  id: string; name: string; sessionId: string; templateId: string; goal: string; workingDir: string
  frequency: WorkflowFrequency; intervalMinutes?: number; nextRunAt: number; enabled: boolean
  lastRunAt?: number; lastWorkflowId?: string; createdAt: number; updatedAt: number
}

export interface WorkflowAnalyticsView {
  periodDays: number
  total: number
  completed: number
  failed: number
  cancelled: number
  active: number
  successRate: number
  averageDurationMs: number
  nodeCompletionRate: number
  daily: Array<{ date: string; total: number; completed: number; failed: number }>
}

export interface NewWorkflowNode {
  key?: string
  title: string
  agentId: string
  prompt: string
  dependsOn?: string[]
  condition?: WorkflowNodeCondition
  resourceClaims?: ResourceClaims
}

export const WorkflowRepo = {
  create(input: {
    sessionId: string; templateId: string; goal: string; workingDir: string; nodes: NewWorkflowNode[]
    failurePolicy?: WorkflowFailurePolicy
  }): WorkflowRunView {
    const db = getDb()
    const id = `workflow-${randomUUID()}`
    const now = Date.now()
    const nodeIds = input.nodes.map(() => `workflow-node-${randomUUID()}`)
    const nodeIdByKey = new Map(input.nodes.map((node, index) => [node.key ?? String(index), nodeIds[index]!]))
    const insert = db.transaction(() => {
      db.run(
        `INSERT INTO workflow_runs
          (id, session_id, template_id, goal, working_dir, status, failure_policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?)`,
        [id, input.sessionId, input.templateId, input.goal, input.workingDir,
          JSON.stringify(normalizeFailurePolicy(input.failurePolicy)), now, now],
      )
      input.nodes.forEach((node, ordinal) => {
        const dependencies = node.dependsOn === undefined
          ? (ordinal > 0 ? [nodeIds[ordinal - 1]!] : [])
          : node.dependsOn.map((key) => nodeIdByKey.get(key) ?? key)
        db.run(
          `INSERT INTO workflow_nodes
            (id, workflow_id, ordinal, title, agent_id, prompt, status, depends_on, condition, resource_claims, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [nodeIds[ordinal], id, ordinal, node.title, node.agentId, node.prompt, JSON.stringify(dependencies),
            node.condition ? JSON.stringify({ ...node.condition, nodeId: nodeIdByKey.get(node.condition.nodeId) ?? node.condition.nodeId }) : "",
            JSON.stringify(node.resourceClaims ?? { reads: [], writes: [] }), now],
        )
      })
    })
    insert()
    return this.get(id)!
  },

  get(id: string): WorkflowRunView | null {
    const row = getDb().query("SELECT * FROM workflow_runs WHERE id = ?").get(id) as WorkflowRunRow | null
    return row ? mapRun(row, this.listNodes(id)) : null
  },

  list(sessionId?: string, limit = 30): WorkflowRunView[] {
    const safeLimit = Math.max(1, Math.min(limit, 100))
    const rows = (sessionId
      ? getDb().query("SELECT * FROM workflow_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(sessionId, safeLimit)
      : getDb().query("SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?").all(safeLimit)) as WorkflowRunRow[]
    return rows.map((row) => mapRun(row, this.listNodes(row.id)))
  },

  analytics(sessionId?: string, requestedDays = 30): WorkflowAnalyticsView {
    const periodDays = Math.max(7, Math.min(90, Math.round(requestedDays)))
    const startAt = Date.now() - periodDays * 24 * 60 * 60 * 1_000
    const runs = (sessionId
      ? getDb().query("SELECT * FROM workflow_runs WHERE session_id = ? AND created_at >= ? ORDER BY created_at ASC").all(sessionId, startAt)
      : getDb().query("SELECT * FROM workflow_runs WHERE created_at >= ? ORDER BY created_at ASC").all(startAt)) as WorkflowRunRow[]
    const nodeRows = (sessionId
      ? getDb().query(`SELECT n.status FROM workflow_nodes n
          JOIN workflow_runs r ON r.id = n.workflow_id
          WHERE r.session_id = ? AND r.created_at >= ?`).all(sessionId, startAt)
      : getDb().query(`SELECT n.status FROM workflow_nodes n
          JOIN workflow_runs r ON r.id = n.workflow_id
          WHERE r.created_at >= ?`).all(startAt)) as Array<{ status: WorkflowNodeStatus }>
    return buildWorkflowAnalytics(
      runs.map((run) => ({
        status: run.status, createdAt: run.created_at,
        startedAt: run.started_at ?? undefined, completedAt: run.completed_at ?? undefined,
      })),
      nodeRows.map((node) => node.status), periodDays,
    )
  },

  listNodes(workflowId: string): WorkflowNodeView[] {
    const rows = getDb().query("SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY ordinal ASC").all(workflowId) as WorkflowNodeRow[]
    return rows.map(mapNode)
  },

  getNode(id: string): WorkflowNodeView | null {
    const row = getDb().query("SELECT * FROM workflow_nodes WHERE id = ?").get(id) as WorkflowNodeRow | null
    return row ? mapNode(row) : null
  },

  updateRun(id: string, fields: Partial<Pick<WorkflowRunView, "status" | "currentNodeId" | "report" | "startedAt" | "completedAt">>): void {
    updateRow("workflow_runs", id, fields, {
      status: "status", currentNodeId: "current_node_id", report: "report",
      startedAt: "started_at", completedAt: "completed_at",
    })
  },

  updateNode(id: string, fields: Partial<Pick<WorkflowNodeView,
    "status" | "result" | "error" | "attempt" | "taskRunId" | "startedAt" | "completedAt"
  >>): void {
    updateRow("workflow_nodes", id, fields, {
      status: "status", result: "result", error: "error", attempt: "attempt",
      taskRunId: "task_run_id", startedAt: "started_at", completedAt: "completed_at",
    })
  },

  recoverInterrupted(): number {
    const db = getDb()
    const now = Date.now()
    const runs = db.run(
      "UPDATE workflow_runs SET status = 'paused', updated_at = ? WHERE status IN ('running', 'pausing')",
      [now],
    ).changes
    db.run(
      "UPDATE workflow_nodes SET status = 'paused', updated_at = ? WHERE status IN ('queued', 'running')",
      [now],
    )
    return runs
  },

  delete(id: string): void {
    getDb().run("DELETE FROM workflow_runs WHERE id = ?", [id])
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM workflow_runs WHERE session_id = ?", [sessionId])
  },
}

export function buildWorkflowAnalytics(
  runs: Array<{ status: WorkflowStatus; createdAt: number; startedAt?: number; completedAt?: number }>,
  nodeStatuses: WorkflowNodeStatus[],
  requestedDays = 30,
  now = Date.now(),
): WorkflowAnalyticsView {
    const periodDays = Math.max(7, Math.min(90, Math.round(requestedDays)))
    const completed = runs.filter((run) => run.status === "completed").length
    const failed = runs.filter((run) => run.status === "failed").length
    const cancelled = runs.filter((run) => run.status === "cancelled").length
    const terminal = completed + failed
    const durations = runs.flatMap((run) => run.startedAt && run.completedAt
      ? [Math.max(0, run.completedAt - run.startedAt)] : [])
    const completedNodes = nodeStatuses.filter((status) => ["completed", "skipped"].includes(status)).length
    const dailyMap = new Map<string, { total: number; completed: number; failed: number }>()
    for (let offset = periodDays - 1; offset >= 0; offset--) {
      const date = new Date(now - offset * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)
      dailyMap.set(date, { total: 0, completed: 0, failed: 0 })
    }
    for (const run of runs) {
      const date = new Date(run.createdAt).toISOString().slice(0, 10)
      const point = dailyMap.get(date)
      if (!point) continue
      point.total++
      if (run.status === "completed") point.completed++
      if (run.status === "failed") point.failed++
    }
    return {
      periodDays, total: runs.length, completed, failed, cancelled,
      active: runs.length - completed - failed - cancelled,
      successRate: terminal === 0 ? 0 : completed / terminal,
      averageDurationMs: durations.length === 0 ? 0 : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      nodeCompletionRate: nodeStatuses.length === 0 ? 0 : completedNodes / nodeStatuses.length,
      daily: [...dailyMap].map(([date, values]) => ({ date, ...values })),
    }
}

export const WorkflowScheduleRepo = {
  create(input: Omit<WorkflowScheduleView, "id" | "enabled" | "lastRunAt" | "lastWorkflowId" | "createdAt" | "updatedAt"> & { enabled?: boolean }): WorkflowScheduleView {
    const id = `workflow-schedule-${randomUUID()}`
    const now = Date.now()
    getDb().run(
      `INSERT INTO workflow_schedules
        (id, name, session_id, template_id, goal, working_dir, frequency, interval_minutes, next_run_at, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.name, input.sessionId, input.templateId, input.goal, input.workingDir, input.frequency,
        input.intervalMinutes ?? null, input.nextRunAt, input.enabled === false ? 0 : 1, now, now],
    )
    return this.get(id)!
  },

  get(id: string): WorkflowScheduleView | null {
    const row = getDb().query("SELECT * FROM workflow_schedules WHERE id = ?").get(id) as WorkflowScheduleRow | null
    return row ? mapSchedule(row) : null
  },

  list(sessionId?: string): WorkflowScheduleView[] {
    const rows = (sessionId
      ? getDb().query("SELECT * FROM workflow_schedules WHERE session_id = ? ORDER BY next_run_at ASC").all(sessionId)
      : getDb().query("SELECT * FROM workflow_schedules ORDER BY next_run_at ASC").all()) as WorkflowScheduleRow[]
    return rows.map(mapSchedule)
  },

  listDue(now = Date.now()): WorkflowScheduleView[] {
    const rows = getDb().query(
      "SELECT * FROM workflow_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 20",
    ).all(now) as WorkflowScheduleRow[]
    return rows.map(mapSchedule)
  },

  update(id: string, fields: Partial<Pick<WorkflowScheduleView,
    "name" | "goal" | "frequency" | "intervalMinutes" | "nextRunAt" | "enabled" | "lastRunAt" | "lastWorkflowId"
  >>): void {
    const normalized = { ...fields, enabled: fields.enabled === undefined ? undefined : fields.enabled ? 1 : 0 }
    updateRow("workflow_schedules", id, normalized, {
      name: "name", goal: "goal", frequency: "frequency", intervalMinutes: "interval_minutes",
      nextRunAt: "next_run_at", enabled: "enabled", lastRunAt: "last_run_at", lastWorkflowId: "last_workflow_id",
    })
  },

  delete(id: string): void {
    getDb().run("DELETE FROM workflow_schedules WHERE id = ?", [id])
  },

  deleteBySession(sessionId: string): void {
    getDb().run("DELETE FROM workflow_schedules WHERE session_id = ?", [sessionId])
  },
}

function updateRow(table: string, id: string, fields: Record<string, unknown>, columns: Record<string, string>): void {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || !columns[key]) continue
    sets.push(`${columns[key]} = ?`)
    values.push(value)
  }
  if (sets.length === 0) return
  sets.push("updated_at = ?")
  values.push(Date.now(), id)
  getDb().run(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, values as any[])
}

function mapRun(row: WorkflowRunRow, nodes: WorkflowNodeView[]): WorkflowRunView {
  return {
    id: row.id, sessionId: row.session_id, templateId: row.template_id, goal: row.goal,
    workingDir: row.working_dir, status: row.status, currentNodeId: row.current_node_id ?? undefined,
    report: row.report ?? undefined, failurePolicy: parseFailurePolicy(row.failure_policy),
    createdAt: row.created_at, startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined, updatedAt: row.updated_at, nodes,
  }
}

function mapNode(row: WorkflowNodeRow): WorkflowNodeView {
  let dependsOn: string[] = []
  try { dependsOn = JSON.parse(row.depends_on) as string[] } catch {}
  let condition: WorkflowNodeCondition | undefined
  try { condition = row.condition ? JSON.parse(row.condition) as WorkflowNodeCondition : undefined } catch {}
  let resourceClaims: ResourceClaims = { reads: [], writes: [] }
  try { resourceClaims = JSON.parse(row.resource_claims || "{}") as ResourceClaims } catch {}
  return {
    id: row.id, workflowId: row.workflow_id, ordinal: row.ordinal, title: row.title,
    agentId: row.agent_id, prompt: row.prompt, status: row.status, dependsOn,
    condition, resourceClaims, result: row.result ?? undefined, error: row.error ?? undefined, attempt: row.attempt,
    taskRunId: row.task_run_id ?? undefined, startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined, updatedAt: row.updated_at,
  }
}

export function normalizeFailurePolicy(value?: Partial<WorkflowFailurePolicy>): WorkflowFailurePolicy {
  return {
    maxRetries: value?.maxRetries === undefined
      ? 1
      : Math.max(0, Math.min(3, Math.round(Number(value.maxRetries) || 0))),
    delaySeconds: Math.max(0, Math.min(300, Math.round(Number(value?.delaySeconds) || 0))),
    siblingFailure: value?.siblingFailure === "fail-fast" ? "fail-fast" : "continue",
  }
}

function parseFailurePolicy(raw: string): WorkflowFailurePolicy {
  try { return normalizeFailurePolicy(JSON.parse(raw) as WorkflowFailurePolicy) }
  catch { return normalizeFailurePolicy() }
}

function mapSchedule(row: WorkflowScheduleRow): WorkflowScheduleView {
  return {
    id: row.id, name: row.name, sessionId: row.session_id, templateId: row.template_id,
    goal: row.goal, workingDir: row.working_dir, frequency: row.frequency,
    intervalMinutes: row.interval_minutes ?? undefined, nextRunAt: row.next_run_at, enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? undefined, lastWorkflowId: row.last_workflow_id ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
