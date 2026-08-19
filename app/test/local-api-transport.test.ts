import { describe, expect, test } from "bun:test"
import {
  fetchWithTransportFallback,
  LocalApiTransportError,
  type FetchTransport,
} from "../src/local-api-transport"

describe("local API transport", () => {
  test("uses the alternate channel only for a transport exception", async () => {
    const calls: string[] = []
    const primary: FetchTransport = async () => {
      calls.push("webview")
      throw new TypeError("Failed to fetch")
    }
    const fallback: FetchTransport = async () => {
      calls.push("native")
      return new Response("ok", { status: 202 })
    }

    const response = await fetchWithTransportFallback("http://127.0.0.1:4096/api/test", {}, primary, fallback)
    expect(response.status).toBe(202)
    expect(calls).toEqual(["webview", "native"])
  })

  test("does not replay an HTTP failure response", async () => {
    let fallbackCalls = 0
    const response = await fetchWithTransportFallback(
      "http://127.0.0.1:4096/api/test",
      {},
      async () => new Response("denied", { status: 403 }),
      async () => {
        fallbackCalls += 1
        return new Response("unexpected")
      },
    )

    expect(response.status).toBe(403)
    expect(fallbackCalls).toBe(0)
  })

  test("reports both channel errors when neither can reach the sidecar", async () => {
    const request = fetchWithTransportFallback(
      "http://127.0.0.1:4096/api/test",
      {},
      async () => { throw new Error("web unavailable") },
      async () => { throw new Error("native unavailable") },
    )

    await expect(request).rejects.toBeInstanceOf(LocalApiTransportError)
    await expect(request).rejects.toThrow("web unavailable；native unavailable")
  })
})
