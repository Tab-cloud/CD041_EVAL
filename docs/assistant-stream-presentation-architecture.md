# Assistant stream presentation architecture

## Scope

This decision covers the independent path from model configuration and a
conversation's selected model through the root model stream to the visible
assistant response. It does not change task completion, tool permission, or
child-Agent settlement semantics.

## Observed failure evidence

- The source UI ran `minimax-m3` with thinking enabled. The model attempt took
  27.6 seconds, but the durable `thinking` start, delta, and end events were
  appended within the final 3 milliseconds of the attempt.
- `ChatView` starts a local timer only while one global `isThinking` boolean is
  true. React can batch the three terminal events into one render, so the timer
  never observes an active interval and the UI reports `0 seconds`.
- `MainAgentDeliveryLedger` does not publish text until a round has finished.
  `AgentLoop` also accumulates provider deltas before yielding one text event.
  Two independent buffers therefore turn a provider stream into a terminal
  snapshot.
- Provider envelopes and their model variants previously had independently
  editable `enabled` flags. Saving could derive a different provider state from
  the variant state, so a switch could visually reverse after normalization.

## Reference design

OpenCode represents reasoning and text as typed parts owned by an assistant
message. Each part has a stable ID, start/end time, and streamed deltas. It does
not use one global reasoning buffer or wait for an entire model round before
publishing text. Codex app-server likewise exposes typed item lifecycle events
instead of a client-only transient timer.

Eval will use the same lightweight principles:

1. A conversation request owns its assistant parts.
2. The server is authoritative for part identity and timestamps.
3. Start, delta, and end are durable events and are replayed after reconnect.
4. Provider reasoning text is optional. The root model attempt still has a
   visible reasoning interval even when a provider emits its summary late.
5. Text deltas are presentation data, not a completion claim. Task completion
   remains the ordinary execution-loop terminal state.
6. Model variants are the only source of runtime availability. Provider
   `enabled` is a derived aggregate, and disabling a selected variant moves the
   affected conversation back to automatic routing.

## Public part contract

The public stream exposes an `assistant-part` lifecycle:

```ts
type AssistantPartEvent = {
  requestId: string
  partId: string
  partType: "reasoning" | "text"
  status: "start" | "delta" | "end"
  text?: string
  timestamp: number
  outcome?: "completed" | "discarded"
}
```

The runtime event log remains the durable source. Restored messages reconstruct
their public parts from these events; raw provider reasoning replay records and
tool protocol data remain private.

## Failure and retry behavior

- A model attempt starts a new reasoning part before transport I/O.
- Provider reasoning deltas append to that part when available.
- A failed or superseded attempt ends its parts as `discarded`; a retry uses new
  part IDs and cannot contaminate the replacement attempt.
- A successful no-tool round completes its text part and ordinary loop
  completion publishes the message. Tool rounds may expose model narration as
  an intermediate typed part, but narration never decides task completion.
- Reconnect replays the same IDs and timestamps, so reducers are idempotent.

## Acceptance

- With `minimax-m3` and thinking enabled, the visible reasoning duration is
  greater than zero for a multi-second model call even if the provider summary
  arrives only at the end.
- Reasoning belongs to the correct assistant response and survives session
  switch, reload, and event replay.
- Text arrives in multiple visible deltas when the provider streams multiple
  chunks; no final-delivery seal delays it until `finish`.
- Disabling an individual model or a provider is stable after save/reload, and
  a disabled selected model falls back to automatic routing.
- Provider failure, fallback, tool use, cancellation, and concurrent sessions
  cannot mix parts between requests.
