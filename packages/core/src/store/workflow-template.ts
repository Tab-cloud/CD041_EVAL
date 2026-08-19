import { randomUUID } from "node:crypto"
import { getDb } from "./database"
import { normalizeFailurePolicy, type WorkflowFailurePolicy, type WorkflowNodeCondition } from "./workflow"
import type { ResourceClaims } from "../runtime/run-contract.ts"

export interface WorkflowTemplateNodeDefinition {
  id: string
  title: string
  agentId: string
  prompt: string
  dependsOn: string[]
  condition?: WorkflowNodeCondition
  resourceClaims?: ResourceClaims
}

export interface CustomWorkflowTemplateView {
  id: string
  name: string
  description: string
  nodes: WorkflowTemplateNodeDefinition[]
  failurePolicy: WorkflowFailurePolicy
  createdAt: number
  updatedAt: number
}

interface WorkflowTemplateRow {
  id: string
  name: string
  description: string
  definition: string
  created_at: number
  updated_at: number
}

export const WorkflowTemplateRepo = {
  create(input: Pick<CustomWorkflowTemplateView, "name" | "description" | "nodes" | "failurePolicy">): CustomWorkflowTemplateView {
    const id = `custom-${randomUUID()}`
    const now = Date.now()
    getDb().run(
      "INSERT INTO workflow_templates (id, name, description, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.name, input.description, JSON.stringify({ nodes: input.nodes, failurePolicy: input.failurePolicy }), now, now],
    )
    return this.get(id)!
  },

  get(id: string): CustomWorkflowTemplateView | null {
    const row = getDb().query("SELECT * FROM workflow_templates WHERE id = ?").get(id) as WorkflowTemplateRow | null
    return row ? mapTemplate(row) : null
  },

  list(): CustomWorkflowTemplateView[] {
    return (getDb().query("SELECT * FROM workflow_templates ORDER BY updated_at DESC").all() as WorkflowTemplateRow[])
      .flatMap((row) => {
        try { return [mapTemplate(row)] } catch { return [] }
      })
  },

  update(id: string, input: Pick<CustomWorkflowTemplateView, "name" | "description" | "nodes" | "failurePolicy">): CustomWorkflowTemplateView | null {
    getDb().run(
      "UPDATE workflow_templates SET name = ?, description = ?, definition = ?, updated_at = ? WHERE id = ?",
      [input.name, input.description, JSON.stringify({ nodes: input.nodes, failurePolicy: input.failurePolicy }), Date.now(), id],
    )
    return this.get(id)
  },

  delete(id: string): void {
    getDb().run("DELETE FROM workflow_templates WHERE id = ?", [id])
  },
}

function mapTemplate(row: WorkflowTemplateRow): CustomWorkflowTemplateView {
  const parsed = JSON.parse(row.definition) as WorkflowTemplateNodeDefinition[] | {
    nodes: WorkflowTemplateNodeDefinition[]
    failurePolicy?: WorkflowFailurePolicy
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes: Array.isArray(parsed) ? parsed : parsed.nodes,
    failurePolicy: normalizeFailurePolicy(Array.isArray(parsed) ? undefined : parsed.failurePolicy),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
