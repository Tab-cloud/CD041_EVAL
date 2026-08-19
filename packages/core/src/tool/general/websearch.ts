import { defineTool } from "../define"
import type { SearchRuntimeConfig, ToolContext } from "../types"

type SearchCategory = "web" | "news"
type SearchFreshness = "any" | "day" | "week" | "month" | "year"

interface SearchInput {
  query: string
  category?: SearchCategory
  freshness?: SearchFreshness
  maxResults?: number
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
  publishedAt?: string
  source?: string
}

const MAX_QUERY_LENGTH = 500
const MAX_RESULTS = 10
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

export const websearchTool = defineTool({
  name: "websearch",
  description: "通用互联网搜索，不限制主题。用于查找网页、实时信息、新闻、产品资料、技术文档和公开事实，返回标题、摘要、时间和 URL。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "自然语言搜索关键词" },
      category: { type: "string", enum: ["web", "news"], description: "搜索类型；省略时根据问题自动判断" },
      freshness: { type: "string", enum: ["any", "day", "week", "month", "year"], description: "结果时效；实时问题应使用 day 或 week" },
      maxResults: { type: "integer", description: "返回条数，范围 1-10" },
    },
    required: ["query"],
  },
  async execute(input: SearchInput, ctx: ToolContext) {
    const query = input.query.trim()
    if (!query) return { success: false, error: "搜索关键词不能为空" }
    if (query.length > MAX_QUERY_LENGTH) return { success: false, error: `搜索关键词不能超过 ${MAX_QUERY_LENGTH} 个字符` }

    const options = inferSearchOptions(query, input.category, input.freshness)
    const configuredMax = Math.min(MAX_RESULTS, Math.max(1, ctx.searchConfig?.maxResults ?? 8))
    const maxResults = Math.min(configuredMax, Math.max(1, input.maxResults ?? configuredMax))
    const timeoutMs = Math.min(30_000, Math.max(3_000, ctx.searchConfig?.timeoutMs ?? REQUEST_TIMEOUT_MS))
    const providers = resolveSearchProviders(options.category, ctx.searchConfig?.provider ?? "auto")
    const attempts: string[] = []

    for (const provider of providers) {
      if (ctx.abortSignal?.aborted) return { success: false, error: "搜索已取消" }
      try {
        const results = await provider(query, options.freshness, maxResults, timeoutMs, ctx.abortSignal)
        if (results.length > 0) {
          return {
            success: true,
            data: {
              query,
              category: options.category,
              freshness: options.freshness,
              provider: provider.providerName,
              searchedAt: new Date().toISOString(),
              results,
            },
          }
        }
        attempts.push(`${provider.providerName}: 无结果`)
      } catch (error) {
        if (ctx.abortSignal?.aborted) return { success: false, error: "搜索已取消" }
        attempts.push(`${provider.providerName}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      success: false,
      error: `搜索未返回结果。已尝试 ${attempts.join("；")}。请调整关键词后重试。`,
    }
  },
  contract: { effects: ["network"], idempotency: "read-only", cancellation: "cooperative", progress: { role: "inspection" } },
  permission: "websearch",
})

export function inferSearchOptions(
  query: string,
  category?: SearchCategory,
  freshness?: SearchFreshness,
): { category: SearchCategory; freshness: SearchFreshness } {
  const newsQuery = /新闻|资讯|头条|快讯|报道|news|headline|breaking/i.test(query)
  const urgentQuery = /今日|今天|实时|刚刚|目前|当前|最新|现在|today|latest|current|now/i.test(query)
  return {
    category: category ?? (newsQuery ? "news" : "web"),
    freshness: freshness ?? (urgentQuery ? "day" : newsQuery ? "week" : "any"),
  }
}

export function resolveSearchProviderNames(
  category: SearchCategory,
  preferred: SearchRuntimeConfig["provider"],
): string[] {
  return resolveSearchProviders(category, preferred).map((provider) => provider.providerName)
}

type SearchProviderFn = (
  query: string,
  freshness: SearchFreshness,
  maxResults: number,
  timeoutMs: number,
  parentSignal?: AbortSignal,
) => Promise<SearchResult[]>

type SearchProvider = SearchProviderFn & { providerName: string }

const searchDuckDuckGo = namedProvider("duckduckgo", async (query, freshness, maxResults, timeoutMs, parentSignal) => {
  const url = new URL("https://html.duckduckgo.com/html/")
  url.searchParams.set("q", query)
  const dateFilters: Partial<Record<SearchFreshness, string>> = { day: "d", week: "w", month: "m", year: "y" }
  const dateFilter = dateFilters[freshness]
  if (dateFilter) url.searchParams.set("df", dateFilter)
  const html = await fetchText(url, timeoutMs, parentSignal)
  return parseDuckDuckGoHtml(html, maxResults)
})

const searchBingWeb = namedProvider("bing", async (query, freshness, maxResults, timeoutMs, parentSignal) => {
  const url = buildBingUrl("https://www.bing.com/search", query, freshness)
  url.searchParams.set("format", "rss")
  return parseRss(await fetchText(url, timeoutMs, parentSignal), maxResults)
})

const searchGoogleNews = namedProvider("google-news", async (query, freshness, maxResults, timeoutMs, parentSignal) => {
  const url = new URL("https://news.google.com/rss/search")
  const newsFreshness: Partial<Record<SearchFreshness, string>> = { day: "1d", week: "7d", month: "30d", year: "365d" }
  const when = newsFreshness[freshness]
  url.searchParams.set("q", when ? `${query} when:${when}` : query)
  url.searchParams.set("hl", "zh-CN")
  url.searchParams.set("gl", "CN")
  url.searchParams.set("ceid", "CN:zh-Hans")
  return parseRss(await fetchText(url, timeoutMs, parentSignal), maxResults)
})

function resolveSearchProviders(category: SearchCategory, preferred: SearchRuntimeConfig["provider"]): SearchProvider[] {
  const newsDefaults = [searchGoogleNews, searchDuckDuckGo, searchBingWeb]
  const webDefaults = [searchDuckDuckGo, searchBingWeb]
  if (preferred === "auto") return category === "news" ? newsDefaults : webDefaults
  const selected = preferred === "duckduckgo" ? searchDuckDuckGo
    : preferred === "bing" ? searchBingWeb
      : category === "news" ? searchGoogleNews : null
  if (!selected) return webDefaults
  const defaults = category === "news" ? newsDefaults : webDefaults
  return [selected, ...defaults.filter((provider) => provider !== selected)]
}

function namedProvider(name: string, provider: SearchProviderFn): SearchProvider {
  return Object.assign(provider, { providerName: name }) as SearchProvider
}

function buildBingUrl(base: string, query: string, freshness: SearchFreshness): URL {
  const url = new URL(base)
  url.searchParams.set("q", query)
  url.searchParams.set("setlang", "zh-cn")
  const freshnessDays: Partial<Record<SearchFreshness, number>> = { day: 1, week: 7, month: 30, year: 365 }
  const days = freshnessDays[freshness]
  if (days) url.searchParams.set("qft", `interval="${days}"`)
  return url
}

async function fetchText(url: URL, timeoutMs: number, parentSignal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 Eval-Agent/1.0",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      Accept: "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("响应内容过大")
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error("响应内容过大")
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

export function parseDuckDuckGoHtml(html: string, maxResults = MAX_RESULTS): SearchResult[] {
  const results: SearchResult[] = []
  const byUrl = new Map<string, SearchResult>()
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = anchorPattern.exec(html)) !== null) {
    const attributes = match[1]
    const className = readAttribute(attributes, "class")
    if (!/(^|\s)result__(a|snippet)(\s|$)/.test(className)) continue
    const url = normalizeResultUrl(readAttribute(attributes, "href"))
    if (!url) continue
    const text = cleanText(match[2])
    if (className.split(/\s+/).includes("result__a")) {
      if (!text || byUrl.has(url) || results.length >= maxResults) continue
      const result = { title: text.slice(0, 200), url, snippet: "" }
      results.push(result)
      byUrl.set(url, result)
    } else if (text) {
      const result = byUrl.get(url)
      if (result && !result.snippet) result.snippet = text.slice(0, 500)
    }
  }
  return results
}

export function parseRss(xml: string, maxResults = MAX_RESULTS): SearchResult[] {
  const results: SearchResult[] = []
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  let match: RegExpExecArray | null
  while ((match = itemPattern.exec(xml)) !== null && results.length < maxResults) {
    const item = match[1]
    let title = cleanText(readElement(item, "title"))
    const url = cleanText(readElement(item, "link"))
    if (!title || !isHttpUrl(url)) continue
    const publishedAt = cleanText(readElement(item, "pubDate"))
    const source = cleanText(readElement(item, "source"))
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim()
    results.push({
      title: title.slice(0, 200),
      url,
      snippet: cleanText(readElement(item, "description")).slice(0, 500),
      ...(publishedAt ? { publishedAt } : {}),
      ...(source ? { source } : {}),
    })
  }
  return results
}

function readAttribute(attributes: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(attributes)
  return decodeEntities(match?.[2] ?? "")
}

function readElement(xml: string, name: string): string {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(xml)
  return match?.[1]?.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1") ?? ""
}

function normalizeResultUrl(rawUrl: string): string | null {
  if (!rawUrl) return null
  try {
    const url = new URL(rawUrl, "https://duckduckgo.com")
    if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
      const target = url.searchParams.get("uddg")
      if (target && isHttpUrl(target)) return new URL(target).href
      return null
    }
    return isHttpUrl(url.href) ? url.href : null
  } catch {
    return null
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function cleanText(value: string): string {
  const decoded = decodeEntities(value)
  const cleaned = decodeEntities(decoded.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
  return repairUtf8Mojibake(cleaned)
}

function repairUtf8Mojibake(value: string): string {
  const markerCount = (value.match(/[ÃÂåäæçèéï]/g) ?? []).length
  if (markerCount < 2 || [...value].some((character) => character.codePointAt(0)! > 255)) return value
  try {
    const bytes = Uint8Array.from([...value], (character) => character.charCodeAt(0))
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return (repaired.match(/[ÃÂåäæçèéï]/g) ?? []).length < markerCount ? repaired : value
  } catch {
    return value
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? entity
    const numeric = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
    try { return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity } catch { return entity }
  })
}
