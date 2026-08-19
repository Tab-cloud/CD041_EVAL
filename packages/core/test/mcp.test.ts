import { afterAll, describe, expect, test } from "bun:test"
import { HttpMcpClient } from "../src/mcp/client.ts"
import { isMcpToolEnabled } from "../src/mcp/manager.ts"

const notifications: string[] = []
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const message = await request.json() as { id?: number; method: string; params?: any }
    if (message.id === undefined) {
      notifications.push(message.method)
      return new Response(null, { status: 202 })
    }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" }, instructions: "Use repository-relative paths." }
      : message.method === "tools/list"
        ? { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
        : message.method === "tools/call"
          ? { content: [{ type: "text", text: message.params.arguments.text }] }
          : message.method === "large"
            ? { value: "x".repeat(2 * 1024 * 1024) }
          : {}
    return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": "test-session" } })
  },
})

afterAll(() => server.stop(true))

describe("MCP HTTP client", () => {
  const client = new HttpMcpClient(`http://127.0.0.1:${server.port}`, {}, 3_000)

  test("initializes, discovers tools and invokes a tool", async () => {
    const initialized = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} })
    expect(initialized.serverInfo.name).toBe("test")
    expect(initialized.instructions).toBe("Use repository-relative paths.")
    await client.notify("notifications/initialized")
    const tools = await client.request("tools/list")
    expect(tools.tools[0].name).toBe("echo")
    const result = await client.request("tools/call", { name: "echo", arguments: { text: "ready" } })
    expect(result.content[0].text).toBe("ready")
    expect(notifications).toContain("notifications/initialized")
  })

  test("rejects oversized HTTP responses", async () => {
    await expect(client.request("large")).rejects.toThrow("MCP HTTP 响应过大")
  })
})

describe("MCP tool catalog filters", () => {
  test("deny list wins and allow list is optional", () => {
    expect(isMcpToolEnabled("read", { enabledTools: [], disabledTools: [] })).toBe(true)
    expect(isMcpToolEnabled("write", { enabledTools: ["read"], disabledTools: [] })).toBe(false)
    expect(isMcpToolEnabled("read", { enabledTools: ["read"], disabledTools: ["read"] })).toBe(false)
  })
})
