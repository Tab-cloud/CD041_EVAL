export type WorkflowStatus = "planned" | "running" | "pausing" | "paused" | "completed" | "failed" | "cancelled"
export type WorkflowNodeStatus = "pending" | "queued" | "running" | "completed" | "failed" | "skipped" | "waiting-human" | "paused" | "cancelled"

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  custom: boolean
  agents: Array<{ id: string; name: string }>
  nodes: WorkflowTemplateNodeDefinition[]
  failurePolicy: WorkflowFailurePolicy
}

export interface WorkflowFailurePolicy { maxRetries: number; delaySeconds: number }
export interface WorkflowNodeCondition { nodeId: string; operator: "contains" | "not-contains" | "equals"; value: string }

export interface WorkflowTemplateNodeDefinition {
  id: string
  title: string
  agentId: string
  prompt: string
  dependsOn: string[]
  condition?: WorkflowNodeCondition
}

export interface WorkflowNode {
  id: string
  ordinal: number
  title: string
  status: WorkflowNodeStatus
  dependsOn: string[]
  condition?: WorkflowNodeCondition
  result?: string
  error?: string
  attempt: number
  startedAt?: number
  completedAt?: number
}

export interface WorkflowRun {
  id: string
  templateId: string
  goal: string
  status: WorkflowStatus
  currentNodeId?: string
  report?: string
  createdAt: number
  failurePolicy: WorkflowFailurePolicy
  nodes: WorkflowNode[]
}

export interface WorkflowAnalytics {
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

export interface WorkflowWebhookSettings {
  url: string
  enabled: boolean
  events: Array<"completed" | "failed">
  secretConfigured: boolean
  updatedAt: number
}

export interface WorkflowWebhookDelivery {
  id: string
  workflowId?: string
  event: "completed" | "failed" | "test"
  status: "pending" | "delivered" | "failed"
  httpStatus?: number
  attempts: number
  error?: string
  createdAt: number
  updatedAt: number
}

export interface WorkflowSchedule {
  id: string
  name: string
  templateId: string
  goal: string
  frequency: "once" | "interval"
  intervalMinutes?: number
  nextRunAt: number
  enabled: boolean
  lastRunAt?: number
}
