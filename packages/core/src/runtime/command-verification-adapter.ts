import type { ToolEvidenceAttestation } from "../tool/types.ts"

export type RequestedCommandVerifier =
  | "process"
  | "build"
  | "test"
  | "regression-test"
  | "stress-test"

/**
 * Convert a successful shell execution into typed evidence.
 *
 * This is deliberately a protocol adapter, not natural-language intent
 * matching. Only a single, recognized test-runner invocation can mint test
 * evidence. Compound shell programs and arbitrary commands such as
 * `echo test` remain process evidence regardless of model-supplied labels.
 */
export function attestSuccessfulCommand(input: {
  command: string
  cwdTarget: string
  requested?: RequestedCommandVerifier
}): ToolEvidenceAttestation[] {
  const processEvidence: ToolEvidenceAttestation = {
    kind: "process-verification",
    targets: [normalizeTarget(input.cwdTarget)],
    producer: "shell-exit-status",
  }
  if (!isControlledTestInvocation(input.command)) return [processEvidence]
  const kind = input.requested === "regression-test"
    ? "regression-test-success"
    : input.requested === "stress-test"
      ? "stress-test-success"
      : input.requested === "test"
        ? "test-success"
        : undefined
  return kind
    ? [processEvidence, {
        kind,
        targets: [normalizeTarget(input.cwdTarget)],
        producer: "controlled-test-runner",
      }]
    : [processEvidence]
}

export function isControlledTestInvocation(command: string): boolean {
  if (hasShellControlOperator(command)) return false
  const tokens = tokenize(command)
  if (tokens.length === 0) return false
  const executable = baseExecutable(tokens[0])
  const args = tokens.slice(1).map((token) => token.toLowerCase())
  if (executable === "bun") return args[0] === "test"
  if (executable === "pnpm" || executable === "npm" || executable === "yarn") {
    return args[0] === "test" || (args[0] === "run" && args[1] === "test")
  }
  if (executable === "cargo") return args[0] === "test"
  if (executable === "go") return args[0] === "test"
  if (executable === "pytest" || executable === "vitest" || executable === "jest" || executable === "ctest") return true
  return (executable === "python" || executable === "python3" || executable === "py")
    && args[0] === "-m" && args[1] === "pytest"
}

function hasShellControlOperator(command: string): boolean {
  let quote: "'" | "\"" | undefined
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (quote) {
      if (character === quote && command[index - 1] !== "\\") quote = undefined
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      continue
    }
    if (character === ";" || character === "|" || character === "&"
      || character === ">" || character === "<" || character === "\n" || character === "\r") return true
  }
  return false
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  for (let index = 0; index < command.trim().length; index++) {
    const character = command.trim()[index]
    if (quote) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += character
    }
  }
  if (current) tokens.push(current)
  return quote ? [] : tokens
}

function baseExecutable(value: string): string {
  const normalized = value.replaceAll("\\", "/")
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase()
  return base.endsWith(".exe") ? base.slice(0, -4) : base
}

function normalizeTarget(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase()
}
