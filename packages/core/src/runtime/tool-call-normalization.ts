const TOOL_NAME_ALIASES = new Map<string, string>([
  ["todo_write", "todowrite"],
  ["todoWrite", "todowrite"],
  ["shell", "bash"],
  ["shell_command", "bash"],
])

export interface NormalizedToolCall {
  name: string
  input: Record<string, unknown>
}

/**
 * Canonicalize provider tool dialects before schema lookup, authorization,
 * audit persistence and execution. Aliases never widen permissions: the
 * canonical tool must still be visible to the current Agent and scope.
 */
export function normalizeInboundToolCall(
  name: string,
  input: Record<string, unknown>,
): NormalizedToolCall {
  const canonicalName = normalizeToolCallName(name)
  return {
    name: canonicalName,
    input: canonicalName === "bash" ? normalizeBashInput(input) : input,
  }
}

export function normalizeToolCallName(name: string): string {
  return TOOL_NAME_ALIASES.get(name) ?? name
}

function normalizeBashInput(input: Record<string, unknown>): Record<string, unknown> {
  const command = firstString(input.command, input.exec, input.cmd)
  const cwd = firstString(input.cwd, input.workdir)
  const outputTarget = input.outputTarget === "build" || input.outputTarget === "terminal"
    ? input.outputTarget
    : undefined
  const timeoutMs = firstFiniteNumber(input.timeoutMs, input.timeout_ms, input.timeout, input["timeout-ms"])
  return {
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(outputTarget ? { outputTarget } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  const value = values.find((item) => typeof item === "number" && Number.isFinite(item))
  return typeof value === "number" ? value : undefined
}
