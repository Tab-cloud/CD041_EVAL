import { RuntimeLeaderLeaseRepo } from "../store/runtime-leader-lease.ts"

const LEADER_LEASE_MS = 15_000
const LEADER_HEARTBEAT_MS = 5_000
let leader: {
  ownerEpoch: string
  timer: ReturnType<typeof setInterval>
} | null = null

export function startRuntimeLeadership(
  ownerEpoch: string,
  onLost: () => void,
): boolean {
  if (leader?.ownerEpoch === ownerEpoch) return true
  if (leader) return false
  if (!RuntimeLeaderLeaseRepo.acquire(ownerEpoch, LEADER_LEASE_MS)) return false

  let leaseExpiresAt = Date.now() + LEADER_LEASE_MS
  const timer = setInterval(() => {
    const now = Date.now()
    try {
      if (RuntimeLeaderLeaseRepo.heartbeat(ownerEpoch, LEADER_LEASE_MS, now)) {
        leaseExpiresAt = now + LEADER_LEASE_MS
        return
      }
    } catch (error) {
      console.error("[runtime-leadership] heartbeat failed", error)
      // A transient SQLite contention error is not proof that ownership was
      // lost. The last committed expiry remains authoritative.
      if (now < leaseExpiresAt) return
    }
    // Leadership is a fencing token. Once lost, this process must never
    // continue scheduling or recover the lease under the same epoch.
    clearInterval(timer)
    leader = null
    onLost()
  }, LEADER_HEARTBEAT_MS)
  ;(timer as { unref?: () => void }).unref?.()
  leader = { ownerEpoch, timer }
  return true
}

export function stopRuntimeLeadership(ownerEpoch: string, retire: boolean): void {
  if (leader?.ownerEpoch === ownerEpoch) {
    clearInterval(leader.timer)
    leader = null
  }
  if (retire) RuntimeLeaderLeaseRepo.retire(ownerEpoch)
}
