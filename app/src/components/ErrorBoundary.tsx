import { Component, type ReactNode } from "react"
import { AlertCircleIcon } from "./Icons"

interface Props { children: ReactNode }
interface State { hasError: boolean; error: string | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message }
  }

  componentDidCatch(error: Error) {
    console.error("ErrorBoundary caught:", error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          height: "100vh", color: "var(--text-primary)", background: "var(--bg-root)",
          fontFamily: "system-ui, sans-serif", gap: 16, padding: 40, textAlign: "center",
        }}>
          <AlertCircleIcon size={48} style={{ opacity: 0.3 }} />
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>应用出现异常</h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 500 }}>{this.state.error}</p>
          <button
            className="btn btn-primary"
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
