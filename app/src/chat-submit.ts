export function canSubmitChat(hasText: boolean, attachmentCount: number): boolean {
  return hasText || attachmentCount > 0
}

export function shouldClearChatComposer(result: false | void): boolean {
  return result !== false
}

export type SlashCommandSelection =
  | { kind: "execute"; command: string }
  | { kind: "compose"; text: string }

export function selectSlashCommand(command: string): SlashCommandSelection {
  return command === "/clear"
    ? { kind: "execute", command }
    : { kind: "compose", text: `${command} ` }
}

export function normalizeHistoricalResubmission(text: string): string | null {
  const normalized = text.trim()
  return normalized || null
}
