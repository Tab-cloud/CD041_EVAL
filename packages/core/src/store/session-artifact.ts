import { createHash, randomUUID } from "node:crypto"
import { getDb } from "./database.ts"

export type SessionArtifactKind =
  | "schematic-page"
  | "schematic-summary"
  | "datasheet"
  | "document"
  | "delivery-file"
  | "delivery-manifest"

export interface SessionArtifact {
  id: string
  sessionId: string
  kind: SessionArtifactKind
  source: string
  slot: string
  title: string
  content: string
  metadata: Record<string, unknown>
  sourceHash?: string
  revision: number
  updatedAt: number
}

export interface SessionArtifactSnapshot {
  sessionId: string
  revision: number
  artifacts: SessionArtifact[]
}

interface ArtifactRow {
  id: string
  session_id: string
  kind: SessionArtifactKind
  source: string
  slot: string
  title: string
  content: string
  metadata: string
  source_hash: string | null
  revision: number
  updated_at: number
}

export const SessionArtifactRepo = {
  snapshot(sessionId: string): SessionArtifactSnapshot {
    const state = getDb().query(
      "SELECT revision FROM session_artifact_state WHERE session_id = ?",
    ).get(sessionId) as { revision: number } | null
    const rows = getDb().query(
      "SELECT * FROM session_artifacts WHERE session_id = ? ORDER BY revision ASC",
    ).all(sessionId) as ArtifactRow[]
    return {
      sessionId,
      revision: state?.revision ?? 0,
      artifacts: rows.map(mapArtifact),
    }
  },

  upsert(input: {
    sessionId: string
    kind: SessionArtifactKind
    source: string
    slot?: string
    title?: string
    content: string
    metadata?: Record<string, unknown>
    sourceHash?: string
  }): SessionArtifact {
    const db = getDb()
    return db.transaction(() => {
      const now = Date.now()
      const slot = input.slot ?? "default"
      db.run(
        `INSERT INTO session_artifact_state (session_id, revision)
         VALUES (?, 1)
         ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1`,
        [input.sessionId],
      )
      const revision = (db.query(
        "SELECT revision FROM session_artifact_state WHERE session_id = ?",
      ).get(input.sessionId) as { revision: number }).revision
      const existing = db.query(
        `SELECT id FROM session_artifacts
         WHERE session_id = ? AND kind = ? AND source = ? AND slot = ?`,
      ).get(input.sessionId, input.kind, input.source, slot) as { id: string } | null
      const id = existing?.id ?? `artifact-${randomUUID()}`
      db.run(
        `INSERT INTO session_artifacts
         (id, session_id, kind, source, slot, title, content, metadata, source_hash, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, kind, source, slot) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           metadata = excluded.metadata,
           source_hash = excluded.source_hash,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
        [
          id, input.sessionId, input.kind, input.source, slot,
          input.title ?? fileName(input.source), input.content,
          JSON.stringify(input.metadata ?? {}),
          input.sourceHash ?? contentHash(input.content),
          revision, now,
        ],
      )
      db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [now, input.sessionId])
      return mapArtifact(db.query("SELECT * FROM session_artifacts WHERE id = ?").get(id) as ArtifactRow)
    })()
  },

  remove(sessionId: string, artifactId: string): SessionArtifactSnapshot {
    const db = getDb()
    db.transaction(() => {
      const removed = db.run(
        "DELETE FROM session_artifacts WHERE id = ? AND session_id = ?",
        [artifactId, sessionId],
      )
      if (removed.changes === 0) return
      db.run(
        `INSERT INTO session_artifact_state (session_id, revision)
         VALUES (?, 1)
         ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1`,
        [sessionId],
      )
      db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [Date.now(), sessionId])
    })()
    return this.snapshot(sessionId)
  },

  clear(sessionId: string): SessionArtifactSnapshot {
    const db = getDb()
    db.transaction(() => {
      db.run("DELETE FROM session_artifacts WHERE session_id = ?", [sessionId])
      db.run(
        `INSERT INTO session_artifact_state (session_id, revision)
         VALUES (?, 1)
         ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1`,
        [sessionId],
      )
      db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [Date.now(), sessionId])
    })()
    return this.snapshot(sessionId)
  },

  deleteBySession(sessionId: string): void {
    const db = getDb()
    db.transaction(() => {
      db.run("DELETE FROM session_artifacts WHERE session_id = ?", [sessionId])
      db.run("DELETE FROM session_artifact_state WHERE session_id = ?", [sessionId])
    })()
  },
}

export function projectSessionArtifacts(
  snapshot: SessionArtifactSnapshot,
  currentSourceHash?: (source: string) => string | undefined,
): {
  artifactRevision: number
  schematics: Array<Record<string, unknown>>
  documents: Array<Record<string, unknown>>
} {
  const schematics: Array<Record<string, unknown>> = []
  const documents: Array<Record<string, unknown>> = []
  for (const artifact of snapshot.artifacts) {
    const liveHash = currentSourceHash?.(artifact.source)
    const freshness = artifact.sourceHash && liveHash
      ? { sourceHash: artifact.sourceHash, stale: artifact.sourceHash !== liveHash }
      : artifact.sourceHash ? { sourceHash: artifact.sourceHash } : {}
    if (artifact.kind === "schematic-page" || artifact.kind === "schematic-summary") {
      schematics.push({
        ...artifact.metadata,
        ...freshness,
        artifactId: artifact.id,
        kind: artifact.kind === "schematic-summary" ? "summary" : "page",
        filePath: artifact.source,
        analysis: artifact.content,
        timestamp: artifact.updatedAt,
      })
    } else if (artifact.kind === "datasheet"
      || artifact.kind === "document"
      || (artifact.kind === "delivery-file" && artifact.metadata.documentView === true)) {
      documents.push({
        ...artifact.metadata,
        ...freshness,
        artifactId: artifact.id,
        title: artifact.title,
        source: artifact.source,
        type: artifact.kind === "datasheet" ? "datasheet" : String(artifact.metadata.type ?? "other"),
        summary: artifact.content,
        timestamp: artifact.updatedAt,
      })
    }
  }
  return { artifactRevision: snapshot.revision, schematics, documents }
}

function mapArtifact(row: ArtifactRow): SessionArtifact {
  let metadata: Record<string, unknown> = {}
  try { metadata = JSON.parse(row.metadata) } catch {}
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    source: row.source,
    slot: row.slot,
    title: row.title,
    content: row.content,
    metadata,
    sourceHash: row.source_hash ?? undefined,
    revision: row.revision,
    updatedAt: row.updated_at,
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}
