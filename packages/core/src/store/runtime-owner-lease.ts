import { getDb } from "./database"

export interface RuntimeOwnerLease {
  ownerEpoch: string
  processId: number
  heartbeatAt: number
  leaseExpiresAt: number
}

interface RuntimeOwnerLeaseRow {
  owner_epoch: string
  process_id: number
  heartbeat_at: number
  lease_expires_at: number
}

export const RuntimeOwnerLeaseRepo = {
  register(ownerEpoch: string, leaseMs: number, now = Date.now()): RuntimeOwnerLease {
    getDb().run(
      `INSERT INTO runtime_owner_leases
       (owner_epoch, process_id, heartbeat_at, lease_expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_epoch) DO UPDATE SET
         process_id = excluded.process_id,
         heartbeat_at = excluded.heartbeat_at,
         lease_expires_at = excluded.lease_expires_at`,
      [ownerEpoch, process.pid, now, now + leaseMs],
    )
    return this.get(ownerEpoch)!
  },

  heartbeat(ownerEpoch: string, leaseMs: number, now = Date.now()): boolean {
    return getDb().query(
      `UPDATE runtime_owner_leases
       SET heartbeat_at = ?, lease_expires_at = ?
       WHERE owner_epoch = ? AND lease_expires_at > ?`,
    ).run(now, now + leaseMs, ownerEpoch, now).changes === 1
  },

  isActive(ownerEpoch: string, now = Date.now()): boolean {
    const row = getDb().query(
      `SELECT 1 FROM runtime_owner_leases
       WHERE owner_epoch = ? AND lease_expires_at > ?`,
    ).get(ownerEpoch, now)
    return Boolean(row)
  },

  get(ownerEpoch: string): RuntimeOwnerLease | null {
    const row = getDb().query(
      "SELECT * FROM runtime_owner_leases WHERE owner_epoch = ?",
    ).get(ownerEpoch) as RuntimeOwnerLeaseRow | null
    return row ? toView(row) : null
  },

  retire(ownerEpoch: string): void {
    getDb().run("DELETE FROM runtime_owner_leases WHERE owner_epoch = ?", [ownerEpoch])
  },

  pruneExpired(now = Date.now()): number {
    return getDb().query(
      "DELETE FROM runtime_owner_leases WHERE lease_expires_at <= ?",
    ).run(now).changes
  },
}

function toView(row: RuntimeOwnerLeaseRow): RuntimeOwnerLease {
  return {
    ownerEpoch: row.owner_epoch,
    processId: row.process_id,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
  }
}
