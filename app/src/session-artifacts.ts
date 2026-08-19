import { apiFetch } from "./api"
import type { AppAction, DocumentItem, SchematicData } from "./store"
import type { Dispatch } from "react"

export interface SessionArtifactSnapshot {
  artifactRevision: number
  schematics: SchematicData[]
  documents: DocumentItem[]
}

export async function refreshSessionArtifacts(
  sessionId: string,
  dispatch: Dispatch<AppAction>,
): Promise<SessionArtifactSnapshot> {
  const response = await apiFetch(`/api/sessions/artifacts?sessionId=${encodeURIComponent(sessionId)}`)
  if (!response.ok) throw new Error(`资料刷新失败: HTTP ${response.status}`)
  const data = await response.json() as Partial<SessionArtifactSnapshot>
  const snapshot = {
    artifactRevision: Number(data.artifactRevision) || 0,
    schematics: Array.isArray(data.schematics) ? data.schematics : [],
    documents: Array.isArray(data.documents) ? data.documents : [],
  }
  dispatch({
    type: "SET_ARTIFACTS",
    revision: snapshot.artifactRevision,
    schematics: snapshot.schematics,
    documents: snapshot.documents,
  })
  return snapshot
}

export async function deleteSessionArtifact(
  sessionId: string,
  artifactId: string,
  dispatch: Dispatch<AppAction>,
): Promise<SessionArtifactSnapshot> {
  const response = await apiFetch(
    `/api/sessions/artifacts?sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(artifactId)}`,
    { method: "DELETE" },
  )
  if (!response.ok) throw new Error(`资料删除失败: HTTP ${response.status}`)
  const data = await response.json() as SessionArtifactSnapshot
  const snapshot = {
    artifactRevision: Number(data.artifactRevision) || 0,
    schematics: Array.isArray(data.schematics) ? data.schematics : [],
    documents: Array.isArray(data.documents) ? data.documents : [],
  }
  dispatch({
    type: "SET_ARTIFACTS",
    revision: snapshot.artifactRevision,
    schematics: snapshot.schematics,
    documents: snapshot.documents,
  })
  return snapshot
}
