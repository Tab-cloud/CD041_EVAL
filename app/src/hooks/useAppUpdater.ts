import { useCallback, useEffect, useRef, useState, type Dispatch } from "react"
import { relaunch } from "@tauri-apps/plugin-process"
import { check, type Update } from "@tauri-apps/plugin-updater"
import type { AppAction } from "../store"

export type UpdaterPhase = "idle" | "checking" | "available" | "downloading" | "installing" | "error"

export interface AppUpdaterState {
  open: boolean
  phase: UpdaterPhase
  currentVersion: string
  version: string
  notes: string
  mandatory: boolean
  downloadedBytes: number
  totalBytes: number | null
  error: string | null
}

const initialState: AppUpdaterState = {
  open: false,
  phase: "idle",
  currentVersion: "",
  version: "",
  notes: "",
  mandatory: false,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export function useAppUpdater(dispatch: Dispatch<AppAction>) {
  const [state, setState] = useState<AppUpdaterState>(initialState)
  const updateRef = useRef<Update | null>(null)
  const checkingRef = useRef(false)

  const checkForUpdate = useCallback(async (manual = false) => {
    if (!isTauriRuntime() || checkingRef.current) return
    checkingRef.current = true
    if (manual) setState(previous => ({ ...previous, open: true, phase: "checking", error: null }))
    try {
      const update = await check({ timeout: 15_000 })
      if (updateRef.current && updateRef.current !== update) await updateRef.current.close().catch(() => undefined)
      updateRef.current = update
      dispatch({ type: "SET_UPDATE_AVAILABLE", available: Boolean(update) })
      if (!update) {
        if (manual) setState(previous => ({ ...previous, phase: "idle" }))
        return
      }
      const mandatory = update.rawJson.mandatory === true
      setState(previous => ({
        open: manual || mandatory || previous.open,
        phase: "available",
        currentVersion: update.currentVersion,
        version: update.version,
        notes: update.body ?? "",
        mandatory,
        downloadedBytes: 0,
        totalBytes: null,
        error: null,
      }))
    } catch (error) {
      dispatch({ type: "SET_UPDATE_AVAILABLE", available: false })
      if (manual) {
        setState(previous => ({
          ...previous,
          open: true,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    } finally {
      checkingRef.current = false
    }
  }, [dispatch])

  const install = useCallback(async () => {
    const update = updateRef.current
    if (!update || state.phase === "downloading" || state.phase === "installing") return
    setState(previous => ({ ...previous, phase: "downloading", downloadedBytes: 0, totalBytes: null, error: null }))
    try {
      let downloadedBytes = 0
      await update.downloadAndInstall(event => {
        if (event.event === "Started") {
          setState(previous => ({ ...previous, phase: "downloading", totalBytes: event.data.contentLength ?? null }))
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength
          setState(previous => ({ ...previous, downloadedBytes }))
        } else {
          setState(previous => ({ ...previous, phase: "installing", downloadedBytes: previous.totalBytes ?? previous.downloadedBytes }))
        }
      }, { timeout: 10 * 60_000 })
      await relaunch()
    } catch (error) {
      setState(previous => ({
        ...previous,
        open: true,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [state.phase])

  const open = useCallback(() => setState(previous => ({ ...previous, open: true })), [])
  const close = useCallback(() => {
    setState(previous => previous.mandatory || previous.phase === "downloading" || previous.phase === "installing"
      ? previous
      : { ...previous, open: false })
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return
    const timer = window.setTimeout(() => void checkForUpdate(false), 4_000)
    const interval = window.setInterval(() => void checkForUpdate(false), 6 * 60 * 60_000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
      void updateRef.current?.close().catch(() => undefined)
    }
  }, [checkForUpdate])

  return { state, checkForUpdate, install, open, close }
}
