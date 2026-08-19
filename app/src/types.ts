export interface ModelConfig {
  id: string
  name: string
  provider: string
  modelId: string
  apiKey?: string
  hasApiKey?: boolean
  clearApiKey?: boolean
  baseUrl?: string
  capabilities: Capability[]
  priority: number
  costFactor: number
  enabled: boolean
  contextWindow: number
  maxOutputTokens: number
  models?: ModelVariantConfig[]
}

export interface ModelVariantConfig {
  id: string
  name: string
  modelId: string
  capabilities: Capability[]
  priority: number
  costFactor: number
  enabled: boolean
  contextWindow: number
  maxOutputTokens: number
}

export type Capability = "vision" | "reasoning" | "coding" | "search" | "chat"

export type DeliveredFileCategory =
  | "source"
  | "document"
  | "presentation"
  | "spreadsheet"
  | "pdf"
  | "firmware"
  | "image"
  | "other"

export interface DeliveredFile {
  artifactId: string
  name: string
  path: string
  relativePath: string
  extension: string
  category: DeliveredFileCategory
  size: number
  exists: boolean
  stale: boolean
  updatedAt: number
}

export interface ChatMessage {
  role: "user" | "assistant" | "system"
  content: string
  /** Stable identity of the user turn. Transport reconnects reuse this id. */
  requestId?: string
  agentId?: string
  seq?: number
  timestamp: number
  attachments?: Array<{ name: string; kind: string }>
  deliveryFiles?: DeliveredFile[]
  parts?: AssistantPart[]
}

export interface AssistantPart {
  id: string
  type: "reasoning" | "text"
  text: string
  state: "streaming" | "completed" | "discarded"
  startedAt: number
  endedAt?: number
  lastEventSeq?: number
}

export interface AssistantPartEvent {
  requestId: string
  partId: string
  partType: AssistantPart["type"]
  status: "start" | "delta" | "end"
  text?: string
  timestamp: number
  outcome?: "completed" | "discarded"
  seq?: number
}

export interface SerialContextPayload {
  port: string
  baudRate: number
  capturedAt: number
  lines: string[]
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  mode: "primary" | "subagent" | "hidden"
  color: string
  tools: string[]
  requiredCapabilities?: Capability[]
  systemPrompt?: string
  maxSteps?: number
  temperature?: number
  source?: "builtin" | "custom"
  projectPath?: string
}
