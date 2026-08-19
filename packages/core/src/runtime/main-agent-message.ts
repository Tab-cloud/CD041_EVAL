/**
 * Builds the durable assistant message independently from live presentation.
 * Text parts are streamed immediately by PublicAgentEventForwarder; this
 * accumulator only selects no-tool rounds for the final conversation record.
 */
export class MainAgentMessageAccumulator {
  private readonly rounds = new Map<string, {
    order: number
    text: string
    hasToolCall: boolean
    finished: boolean
  }>()
  private nextOrder = 0

  observeToolCall(segment: number, round: number): void {
    this.entry(segment, round).hasToolCall = true
  }

  observeText(segment: number, round: number, text: string): void {
    if (text) this.entry(segment, round).text += text
  }

  finishRound(segment: number, round: number): void {
    this.entry(segment, round).finished = true
  }

  delivery(): string {
    return [...this.rounds.values()]
      .sort((left, right) => left.order - right.order)
      .filter((entry) => entry.finished && !entry.hasToolCall)
      .map((entry) => entry.text)
      .join("")
  }

  private entry(segment: number, round: number) {
    const key = `${segment}:${round}`
    let entry = this.rounds.get(key)
    if (!entry) {
      entry = {
        order: this.nextOrder++,
        text: "",
        hasToolCall: false,
        finished: false,
      }
      this.rounds.set(key, entry)
    }
    return entry
  }
}
