import { RUNTIME_EVENT_TYPES, RUNTIME_PROTOCOL_VERSION } from "./runtime-protocol.generated"

export { RUNTIME_EVENT_TYPES, RUNTIME_PROTOCOL_VERSION }
export type { RuntimeEventType } from "./runtime-protocol.generated"

export class RuntimeProtocolError extends Error {}

export function assertRuntimeProtocol(value: unknown): asserts value is { protocolVersion: number } {
  const actual = (value as { protocolVersion?: unknown } | null)?.protocolVersion
  if (actual !== RUNTIME_PROTOCOL_VERSION) {
    throw new RuntimeProtocolError(`Eval 运行时协议不一致：桌面端需要 ${RUNTIME_PROTOCOL_VERSION}，服务端返回 ${String(actual ?? "缺失")}`)
  }
}
