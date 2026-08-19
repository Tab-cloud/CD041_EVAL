import { useCallback, type Dispatch, type MouseEvent as ReactMouseEvent } from "react"
import type { AppAction, AppState } from "../store"

export function usePanelResize(state: AppState, dispatch: Dispatch<AppAction>) {
  const startResize = useCallback((side: "left" | "right") => (event: ReactMouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = side === "left" ? state.sidebarWidth : state.rightPanelWidth
    beginResize((move) => {
      const delta = move.clientX - startX
      dispatch({
        type: side === "left" ? "SET_SIDEBAR_WIDTH" : "SET_RIGHT_PANEL_WIDTH",
        width: side === "left" ? startWidth + delta : startWidth - delta,
      })
    })
  }, [dispatch, state.rightPanelWidth, state.sidebarWidth])

  const startResizeBottom = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = state.bottomPanelHeight
    beginResize((move) => {
      dispatch({ type: "SET_BOTTOM_PANEL_HEIGHT", height: startHeight + startY - move.clientY })
    })
  }, [dispatch, state.bottomPanelHeight])

  return { startResize, startResizeBottom }
}

function beginResize(onMove: (event: MouseEvent) => void): void {
  document.body.classList.add("panel-resizing")
  const onUp = () => {
    document.body.classList.remove("panel-resizing")
    document.removeEventListener("mousemove", onMove)
    document.removeEventListener("mouseup", onUp)
  }
  document.addEventListener("mousemove", onMove)
  document.addEventListener("mouseup", onUp)
}
