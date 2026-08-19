import { RUNTIME_EVENT_TYPES, RUNTIME_PROTOCOL_VERSION } from "./protocol.generated.ts"

export { RUNTIME_EVENT_TYPES, RUNTIME_PROTOCOL_VERSION }
export type { RuntimeEventType } from "./protocol.generated.ts"

export function assertDesktopProtocol(actual: string | undefined): void {
  if (!actual) throw new Error("桌面壳未声明运行时协议")
  if (actual !== String(RUNTIME_PROTOCOL_VERSION)) {
    throw new Error(`桌面壳协议 ${actual} 与服务端协议 ${RUNTIME_PROTOCOL_VERSION} 不一致`)
  }
}
