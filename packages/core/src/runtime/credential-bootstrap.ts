import { configStore } from "./config-store"
import { mcpManager } from "../mcp/manager"
import { setWorkflowWebhookCredential } from "../store/workflow-webhook"
import { setCommunityToken } from "./community-credentials"

interface CredentialBootstrap {
  models?: unknown
  mcp?: unknown
  workflowWebhook?: unknown
  communityToken?: unknown
}

const MAX_BOOTSTRAP_BYTES = 25 * 1024 * 1024

export async function hydrateRuntimeCredentials(): Promise<void> {
  if (process.env.EVAL_CREDENTIAL_BOOTSTRAP !== "stdin") return
  const payload = JSON.parse(await readLineFromStdin()) as CredentialBootstrap
  configStore.setExternalCredentials(payload.models)
  mcpManager.setExternalCredentials(payload.mcp)
  setWorkflowWebhookCredential(typeof payload.workflowWebhook === "string" ? payload.workflowWebhook : "")
  setCommunityToken(payload.communityToken)
}

async function readLineFromStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error("凭据引导管道提前关闭")
      text += decoder.decode(value, { stream: true })
      if (text.length > MAX_BOOTSTRAP_BYTES) throw new Error("凭据引导数据过大")
      const newline = text.indexOf("\n")
      if (newline >= 0) return text.slice(0, newline)
    }
  } finally {
    reader.releaseLock()
  }
}
