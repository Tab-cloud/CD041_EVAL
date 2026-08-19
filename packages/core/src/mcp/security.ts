export type McpSecurityField = "url" | "argument"

export interface McpSecurityIssue {
  code: "url-userinfo" | "url-parameter" | "argument-secret"
  field: McpSecurityField
  name: string
  message: string
}

interface McpSecurityInput {
  url?: string
  args?: string[]
}

const EXACT_SECRET_NAMES = new Set([
  "auth",
  "authorization",
  "bearer",
  "bearertoken",
  "credential",
  "credentials",
  "passphrase",
  "sig",
])

export function findMcpPlaintextSecrets(input: McpSecurityInput): McpSecurityIssue[] {
  const issues: McpSecurityIssue[] = []
  if (input.url) inspectUrl(input.url, issues)
  inspectArguments(input.args ?? [], issues)
  return deduplicate(issues)
}

export function assertMcpSecretsAreIsolated(input: McpSecurityInput, serverId?: string): void {
  const issue = findMcpPlaintextSecrets(input)[0]
  if (!issue) return
  const prefix = serverId ? `MCP ${serverId}：` : ""
  throw new Error(`${prefix}${issue.message}`)
}

export function redactMcpPlaintextSecrets<T extends McpSecurityInput>(input: T): T {
  return {
    ...input,
    ...(input.url ? { url: redactUrl(input.url) } : {}),
    ...(input.args ? { args: redactArguments(input.args) } : {}),
  }
}

function inspectUrl(value: string, issues: McpSecurityIssue[]): void {
  let url: URL
  try { url = new URL(value) } catch { return }
  if (url.username || url.password) {
    issues.push({
      code: "url-userinfo",
      field: "url",
      name: "userinfo",
      message: "URL 中不能包含用户名或密码，请改用请求头凭据",
    })
  }
  inspectParameters(url.searchParams, "查询参数", issues)
  if (url.hash.includes("=")) inspectParameters(new URLSearchParams(url.hash.slice(1)), "片段参数", issues)
}

function redactUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { return value }
  url.username = ""
  url.password = ""
  redactParameters(url.searchParams)
  if (url.hash.includes("=")) {
    const params = new URLSearchParams(url.hash.slice(1))
    redactParameters(params)
    url.hash = params.toString()
  }
  return url.toString()
}

function redactParameters(params: URLSearchParams): void {
  for (const [name, value] of params) if (value && isSensitiveName(name)) params.set(name, "")
}

function inspectParameters(params: URLSearchParams, location: string, issues: McpSecurityIssue[]): void {
  for (const [name, value] of params) {
    if (!value || !isSensitiveName(name)) continue
    issues.push({
      code: "url-parameter",
      field: "url",
      name,
      message: `URL ${location}“${safeName(name)}”可能包含明文凭据，请改用请求头凭据`,
    })
  }
}

function inspectArguments(args: string[], issues: McpSecurityIssue[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ""
    const assignment = argument.match(/^--?([^=\s]{1,100})=(.+)$/)
      ?? argument.match(/^([A-Za-z][A-Za-z0-9_.-]{0,99})=(.+)$/)
    if (assignment && isSensitiveName(assignment[1]!)) {
      addArgumentIssue(assignment[1]!, issues)
      continue
    }

    const option = argument.match(/^--?([A-Za-z][A-Za-z0-9_.-]{0,99})$/)
    const next = args[index + 1]
    if (option && isSensitiveName(option[1]!) && next && !/^--?[A-Za-z]/.test(next)) {
      addArgumentIssue(option[1]!, issues)
      continue
    }

    const jsonSecret = argument.match(/["']([A-Za-z][A-Za-z0-9_.-]{0,99})["']\s*:\s*["'][^"']+["']/)
    if (jsonSecret && isSensitiveName(jsonSecret[1]!)) addArgumentIssue(jsonSecret[1]!, issues)
  }
}

function redactArguments(args: string[]): string[] {
  const redacted: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ""
    const assignment = argument.match(/^(--?[^=\s]{1,100}|[A-Za-z][A-Za-z0-9_.-]{0,99})=(.+)$/)
    const assignmentName = assignment?.[1]?.replace(/^--?/, "")
    if (assignment && assignmentName && isSensitiveName(assignmentName)) {
      redacted.push(`${assignment[1]}=`)
      continue
    }
    const option = argument.match(/^--?([A-Za-z][A-Za-z0-9_.-]{0,99})$/)
    const next = args[index + 1]
    if (option && isSensitiveName(option[1]!) && next && !/^--?[A-Za-z]/.test(next)) {
      redacted.push(`${argument}=`)
      index += 1
      continue
    }
    const jsonSecret = argument.match(/["']([A-Za-z][A-Za-z0-9_.-]{0,99})["']\s*:\s*["'][^"']+["']/)
    redacted.push(jsonSecret && isSensitiveName(jsonSecret[1]!) ? "[已移除明文凭据参数]" : argument)
  }
  return redacted
}

function addArgumentIssue(name: string, issues: McpSecurityIssue[]): void {
  issues.push({
    code: "argument-secret",
    field: "argument",
    name,
    message: `命令参数“${safeName(name)}”可能包含明文凭据，请改用环境变量凭据`,
  })
}

function isSensitiveName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "")
  return EXACT_SECRET_NAMES.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("apikey")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("passwd")
    || normalized.endsWith("signature")
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 100) || "敏感参数"
}

function deduplicate(issues: McpSecurityIssue[]): McpSecurityIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.name.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
