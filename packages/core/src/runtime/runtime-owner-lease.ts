import { RuntimeOwnerLeaseRepo } from "../store/runtime-owner-lease"

export const RUNTIME_OWNER_LEASE_MS = 15_000
const HEARTBEAT_MS = 5_000
const timers = new Map<string, ReturnType<typeof setInterval>>()

export function ensureRuntimeOwnerLease(ownerEpoch: string): void {
  if (timers.has(ownerEpoch)) return
  RuntimeOwnerLeaseRepo.pruneExpired()
  RuntimeOwnerLeaseRepo.register(ownerEpoch, RUNTIME_OWNER_LEASE_MS)
  const timer = setInterval(() => {
    try {
      if (!RuntimeOwnerLeaseRepo.heartbeat(ownerEpoch, RUNTIME_OWNER_LEASE_MS)) {
        // A lease expiry is a fencing event, not a transient heartbeat miss.
        // Re-registering the same epoch would resurrect a stale process after
        // another runtime has already recovered its commands.
        clearInterval(timer)
        timers.delete(ownerEpoch)
        console.error("[runtime-owner-lease] lease lost; owner epoch is fenced")
      }
    } catch (error) {
      console.error("[runtime-owner-lease] heartbeat failed", error)
    }
  }, HEARTBEAT_MS)
  ;(timer as { unref?: () => void }).unref?.()
  timers.set(ownerEpoch, timer)
}

export function stopRuntimeOwnerLease(ownerEpoch: string, retire = false): void {
  const timer = timers.get(ownerEpoch)
  if (timer) clearInterval(timer)
  timers.delete(ownerEpoch)
  if (retire) RuntimeOwnerLeaseRepo.retire(ownerEpoch)
}
