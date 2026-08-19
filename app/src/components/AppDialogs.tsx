import {
  lazy,
  Suspense,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react"
import { apiFetch } from "../api"
import {
  runCredentialTransaction,
  stageModelCredentials,
  syncMcpCredentials,
  syncModelCredentials,
} from "../model-credentials"
import type { AppAction, AppState, LogLine } from "../store"
import type { SystemSettings } from "../system-settings"
import type { AppUpdaterState } from "../hooks/useAppUpdater"
import { SpinnerIcon } from "./Icons"
import type { SettingsTab } from "./SystemSettingsModal"
import type { AccountUser } from "../account"

const SystemSettingsModal = lazy(() => (
  import("./SystemSettingsModal").then((module) => ({ default: module.SystemSettingsModal }))
))
const ModelConfigModal = lazy(() => (
  import("./ModelConfigModal").then((module) => ({ default: module.ModelConfigModal }))
))
const NewTaskDialog = lazy(() => (
  import("./NewTaskDialog").then((module) => ({ default: module.NewTaskDialog }))
))

interface AppDialogsProps {
  state: AppState
  dispatch: Dispatch<AppAction>
  updaterState: AppUpdaterState
  onCheckForUpdate: () => void
  onOpenUpdate: () => void
  settingsTabRef: MutableRefObject<SettingsTab>
  accountLoginAutoStartRef: MutableRefObject<boolean>
  onAccountChanged: (user: AccountUser | null) => void
  activeSessionRef: MutableRefObject<string | null>
  setProjectEffectiveSettings: Dispatch<SetStateAction<SystemSettings | null>>
  persistSystemSettings: (settings: SystemSettings) => Promise<SystemSettings>
  addLogLine: (target: "terminal" | "serial" | "build", text: string, type: LogLine["type"]) => void
}

export function AppDialogs({
  state,
  dispatch,
  updaterState,
  onCheckForUpdate,
  onOpenUpdate,
  settingsTabRef,
  accountLoginAutoStartRef,
  onAccountChanged,
  activeSessionRef,
  setProjectEffectiveSettings,
  persistSystemSettings,
  addLogLine,
}: AppDialogsProps) {
  return (
    <>
      {state.showSystemSettings && (
        <Suspense fallback={<ModalLoading />}>
          <SystemSettingsModal
            settings={state.systemSettings}
            models={state.modelConfigs}
            agents={state.agents}
            workspace={state.workspace}
            connectionStatus={state.connectionStatus}
            updaterState={updaterState}
            onCheckForUpdate={onCheckForUpdate}
            onOpenUpdate={onOpenUpdate}
            initialTab={settingsTabRef.current}
            autoStartAccountLogin={accountLoginAutoStartRef.current}
            onAccountLoginAutoStarted={() => { accountLoginAutoStartRef.current = false }}
            onAccountChanged={onAccountChanged}
            onSave={async (settings) => dispatch({
              type: "SET_SYSTEM_SETTINGS",
              settings: await persistSystemSettings(settings),
            })}
            onOpenModels={() => {
              settingsTabRef.current = "models"
              dispatch({ type: "TOGGLE_SYSTEM_SETTINGS" })
              dispatch({ type: "TOGGLE_MODEL_CONFIG" })
            }}
            onProjectSettingsChanged={setProjectEffectiveSettings}
            onConfigurationRestored={async (settings) => {
              dispatch({ type: "SET_SYSTEM_SETTINGS", settings })
              const response = await apiFetch("/api/models")
              const data = await response.json()
              if (Array.isArray(data.models)) {
                await syncModelCredentials(data.models)
                dispatch({ type: "SET_MODEL_CONFIGS", configs: data.models })
              }
              const mcpResponse = await apiFetch("/api/mcp/servers")
              const mcpData = await mcpResponse.json().catch(() => ({}))
              if (Array.isArray(mcpData.servers)) await syncMcpCredentials(mcpData.servers)
            }}
            onAgentsChanged={async () => {
              const response = await apiFetch("/api/agents")
              if (response.ok) dispatch({ type: "SET_AGENTS", agents: await response.json() })
            }}
            onClose={() => dispatch({ type: "TOGGLE_SYSTEM_SETTINGS" })}
          />
        </Suspense>
      )}
      {state.showModelConfig && (
        <Suspense fallback={<ModalLoading />}>
          <ModelConfigModal
            configs={state.modelConfigs}
            onUpdate={async (configs) => {
              try {
                const validation = await apiFetch("/api/models/validate", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ models: configs }),
                })
                if (!validation.ok) {
                  const data = await validation.json().catch(() => ({}))
                  throw new Error(data.error || `HTTP ${validation.status}`)
                }
                await runCredentialTransaction(stageModelCredentials(configs), async () => {
                  const response = await apiFetch("/api/models", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ models: configs }),
                  })
                  if (!response.ok) {
                    const data = await response.json().catch(() => ({}))
                    throw new Error(data.error || `HTTP ${response.status}`)
                  }
                })
                const refreshed = await apiFetch("/api/models")
                const data = await refreshed.json()
                if (Array.isArray(data.models)) {
                  dispatch({ type: "SET_MODEL_CONFIGS", configs: data.models })
                }
              } catch (error) {
                addLogLine(
                  "build",
                  `模型配置保存失败: ${error instanceof Error ? error.message : String(error)}`,
                  "error",
                )
                throw error
              }
            }}
            onClose={() => {
              dispatch({ type: "TOGGLE_MODEL_CONFIG" })
              dispatch({ type: "TOGGLE_SYSTEM_SETTINGS" })
            }}
          />
        </Suspense>
      )}
      {state.showNewTask && (
        <Suspense fallback={<ModalLoading />}>
          <NewTaskDialog
            initialWorkspace={state.systemSettings.defaultWorkspace}
            onClose={() => dispatch({ type: "TOGGLE_NEW_TASK" })}
            onSelectWorkspace={(_path) => { /* 选择后可在下方输入标题 */ }}
            onCreate={async (title, workspace) => {
              dispatch({ type: "TOGGLE_NEW_TASK" })
              try {
                const sessionResponse = await apiFetch("/api/sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    title: title || workspace.split(/[/\\]/).pop() || "新任务",
                    agentId: "auto",
                    projectPath: workspace,
                  }),
                })
                if (!sessionResponse.ok) throw new Error(`HTTP ${sessionResponse.status}`)
                const newSession = await sessionResponse.json()
                activeSessionRef.current = newSession.id
                dispatch({ type: "SET_WORKSPACE", workspace })
                dispatch({ type: "CREATE_SESSION", session: newSession })
                await apiFetch("/api/projects/init", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ projectPath: workspace, name: newSession.title }),
                })
              } catch (error) {
                addLogLine(
                  "build",
                  `创建会话失败: ${error instanceof Error ? error.message : String(error)}`,
                  "error",
                )
              }
            }}
          />
        </Suspense>
      )}
    </>
  )
}

function ModalLoading() {
  return (
    <div className="modal-loading" role="status" aria-label="加载中">
      <SpinnerIcon size={18} className="spin" />
    </div>
  )
}
