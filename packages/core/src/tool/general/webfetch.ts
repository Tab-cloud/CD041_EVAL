import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { defineTool } from "../define"

const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`非法 URL: ${raw}`) }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅支持 http/https 协议: ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error("URL 不允许包含凭据")

  const host = url.hostname.toLowerCase().replace(/^\[|]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`禁止访问本机地址: ${host}`)
  }

  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0) throw new Error(`域名没有可用地址: ${host}`)
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error(`禁止访问非公网地址: ${address}`)
  }
  return url
}

export function isPrivateAddress(raw: string): boolean {
  const address = raw.toLowerCase().split("%")[0]
  if (address.includes(":")) {
    if (address === "::" || address === "::1") return true
    if (/^f[cd]/.test(address) || /^fe[89ab]/.test(address)) return true
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivateAddress(mapped[1]) : false
  }

  const octets = address.split(".").map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b, c] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113)
}

async function fetchChecked(raw: string, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
  let url = await assertSafeUrl(raw)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(url.href, { redirect: "manual", signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url }
    if (redirects === MAX_REDIRECTS) throw new Error("重定向次数过多")
    const location = response.headers.get("location")
    if (!location) throw new Error(`HTTP ${response.status} 缺少 Location`)
    url = await assertSafeUrl(new URL(location, url).href)
  }
  throw new Error("重定向次数过多")
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`响应过大（最大 ${MAX_RESPONSE_BYTES / 1024 / 1024}MB）`)
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error(`响应过大（最大 ${MAX_RESPONSE_BYTES / 1024 / 1024}MB）`)
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export const webfetchTool = defineTool({
  name: "webfetch",
  description: "抓取指定 URL 的网页内容，返回纯文本或 Markdown。用于读取数据手册、技术文档、参考设计等。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的完整 URL（https:// 开头）" },
    },
    required: ["url"],
  },
  async execute({ url }: { url: string }, ctx) {
    try {
      const timeout = AbortSignal.timeout(30000)
      const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout
      const { response, url: finalUrl } = await fetchChecked(url, signal)
      if (!response.ok) return { success: false, error: `HTTP ${response.status}` }
      const text = await readLimited(response)
      const cleaned = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, 50_000)
        .trim()
      return { success: true, data: { url: finalUrl.href, content: cleaned } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: `抓取失败: ${message}` }
    }
  },
  contract: { effects: ["network"], idempotency: "read-only", cancellation: "cooperative", progress: { role: "inspection" } },
  permission: "webfetch",
})
