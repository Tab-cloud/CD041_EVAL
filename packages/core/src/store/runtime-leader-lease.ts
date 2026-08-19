import { getDb } from "./database.ts"

export interface RuntimeLeaderLease {
  ownerEpoch: string
  processId: number
  heartbeatAt: number
  leaseExpiresAt: number
}

interface RuntimeLeaderLeaseRow {
  owner_epoch: string
  process_id: number
  heartbeat_at: number
  lease_expires_at: number
}

export const RuntimeLeaderLeaseRepo = {
  acquire(ownerEpoch: string, leaseMs: number, now = Date.now()): boolean {
    const db = getDb()
    return db.transaction(() => {
      const current = db.query(
        "SELECT * FROM runtime_leader_lease WHERE singleton = 1",
      ).get() as RuntimeLeaderLeaseRow | null
      if (current && current.owner_epoch !== ownerEpoch && current.lease_expires_at > now) {
        return false
      }
      db.run(
        `INSERT INTO runtime_leader_lease
         (singleton, owner_epoch, process_id, heartbeat_at, lease_expires_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           owner_epoch = excluded.owner_epoch,
           process_id = excluded.process_id,
           heartbeat_at = excluded.heartbeat_at,
           lease_expires_at = excluded.lease_expires_at`,
        [ownerEpoch, process.pid, now, now + leaseMs],
      )
      return true
    }).immediate()
  },

  heartbeat(ownerEpoch: string, leaseMs: number, now = Date.now()): boolean {
    return getDb().query(
      `UPDATE runtime_leader_lease
       SET heartbeat_at = ?, lease_expires_at = ?
       WHERE singleton = 1 AND owner_epoch = ? AND lease_expires_at > ?`,
    ).run(now, now + leaseMs, ownerEpoch, now).changes === 1
  },

  get(): RuntimeLeaderLease | null {
    const row = getDb().query(
      "SELECT * FROM runtime_leader_lease WHERE singleton = 1",
    ).get() as RuntimeLeaderLeaseRow | null
    return row ? {
      ownerEpoch: row.owner_epoch,
      processId: row.process_id,
      heartbeatAt: row.heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
    } : null
  },

  retire(ownerEpoch: string): boolean {
    return getDb().query(
      "DELETE FROM runtime_leader_lease WHERE singleton = 1 AND owner_epoch = ?",
    ).run(ownerEpoch).changes === 1
  },
}
