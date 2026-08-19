import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { apiFetch } from "./api"
import { loadAccountProfile, type AccountUser } from "./account"
import { AccountGate } from "./components/AccountGate"
import { AppDialogs } from "./components/AppDialogs"
import { AppWorkspace } from "./components/AppWorkspace"
import { ErrorBoundary } from "./components/ErrorBoundary"
import type { SettingsTab } from "./components/SystemSettingsModal"
import { TopBar } from "./components/TopBar"
import { UpdateDialog } from "./components/UpdateDialog"
import { useAppLifecycle } from "./hooks/useAppLifecycle"
import { useAppUpdater } from "./hooks/useAppUpdater"
import { useChat } from "./hooks/useChat"
import { usePanelResize } from "./hooks/usePanelResize"
import { useWorkflowNotifications } from "./hooks/useWorkflowNotifications"
import { I18nProvider, translate } from "./i18n"
import { persistSessionComposerPreferences } from "./session-composer-preferences"
import { appReducer, createInitialState } from "./store"
import type { LogLine, SessionComposerPreferences } from "./store"
import { loadCachedSystemSettings, type SystemSettings } from "./system-settings"
import { prepareTaskCompletionNotifications } from "./task-completion-notification"

export default function App() {
  const [gateSettings] = useState(loadCachedSystemSettings)
  const [accountChecking, setAccountChecking] = useState(true)
  const [accountUser, setAccountUser] = useState<AccountUser | null>(null)

  const handleAccountChanged = useCallback((user: AccountUser | null) => {
    setAccountUser(user)
    setAccountChecking(false)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = gateSettings.theme
  }, [gateSettings.theme])

  useEffect(() => {
    let active = true
    void loadAccountProfile()
      .then((profile) => {
        if (!active) return
        setAccountUser(profile)
        setAccountChecking(false)
      })
      .catch(() => {
        if (!active) return
        setAccountUser(null)
        setAccountChecking(false)
      })
    return () => { active = false }
  }, [])

  return (
    <ErrorBoundary>
      {accountChecking || !accountUser ? (
        <I18nProvider language={gateSettings.language}>
          <AccountGate
            language={gateSettings.language}
            checking={accountChecking}
            onAccountChanged={handleAccountChanged}
          />
        </I18nProvider>
      ) : (
        <AuthenticatedApp accountUser={accountUser} onAccountChanged={handleAccountChanged} />
      )}
    </ErrorBoundary>
  )
}

interface AuthenticatedAppProps {
  accountUser: AccountUser
  onAccountChanged: (user: AccountUser | null) => void
}

function AuthenticatedApp({ accountUser, onAccountChanged }: AuthenticatedAppProps) {
  const [state, dispatch] = useReducer(appReducer, null, createInitialState)
  const [projectEffectiveSettings, setProjectEffectiveSettings] = useState<SystemSettings | null>(null)
  const workflowNotifications = useWorkflowNotifications()
  const settingsTabRef = useRef<SettingsTab>("general")
  const accountLoginAutoStartRef = useRef(false)
  const activeSessionRef = useRef<string | null>(state.activeSessionId)
  const sessionsRef = useRef(state.sessions)
  const abortRef = useRef<AbortController | null>(null)
  const requestSequenceRef = useRef(0)
  const updater = useAppUpdater(dispatch)

  useEffect(() => {
    activeSessionRef.current = state.activeSessionId
  }, [state.activeSessionId])
  useEffect(() => {
    sessionsRef.current = state.sessions
  }, [state.sessions])
  useEffect(() => {
    void prepareTaskCompletionNotifications()
  }, [])
  const chat = useChat(state, dispatch, {
    activeSession: activeSessionRef,
    sessions: sessionsRef,
    abort: abortRef,
    requestSequence: requestSequenceRef,
  })
  useAppLifecycle(state, dispatch, chat.stop, chat.recoverTerminalSubscription)

  useEffect(() => {
    if (!state.workspace) {
      setProjectEffectiveSettings(null)
      return
    }
    let current = true
    void apiFetch(`/api/project-settings?projectPath=${encodeURIComponent(state.workspace)}`)
      .then(async (response) => {
        const data = await response.json()
        if (response.ok && current) setProjectEffectiveSettings(data.effective)
      })
      .catch(() => current && setProjectEffectiveSettings(null))
    return () => {
      current = false
    }
  }, [state.systemSettings, state.workspace])

  const resize = usePanelResize(state, dispatch)
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
  const composerPreferences: SessionComposerPreferences = activeSession?.composerPreferences ?? {
    modelId: state.activeModelId,
    effort: projectEffectiveSettings?.defaultEffort ?? state.systemSettings.defaultEffort,
    scope: projectEffectiveSettings?.defaultScope ?? state.systemSettings.defaultScope,
  }
  const addLogLine = (
    target: "terminal" | "serial" | "build",
    text: string,
    type: LogLine["type"],
  ) => {
    dispatch({ type: "ADD_LOG", target, line: { text, type, timestamp: Date.now() } })
  }
  const updateComposerPreferences = (patch: Partial<SessionComposerPreferences>) => {
    if (!state.activeSessionId) return
    const preferences = { ...composerPreferences, ...patch }
    dispatch({ type: "UPDATE_SESSION_PREFERENCES", sessionId: state.activeSessionId, preferences })
    void persistSessionComposerPreferences(state.activeSessionId, patch).catch((error) => {
      addLogLine(
        "build",
        `会话输入设置保存失败: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      )
    })
  }

  return (
    <I18nProvider language={state.systemSettings.language}>
      <>
          <TopBar
            reconnectAttempt={state.reconnectAttempt}
            connectionStatus={state.connectionStatus}
            activeModelId={state.activeModelId}
            modelConfigs={state.modelConfigs}
            theme={state.theme}
            projectName={state.workspace?.split(/[/\\]/).pop()
              ?? translate(state.systemSettings.language, "topbar.noWorkspace")}
            workspacePath={state.workspace}
            accountUser={accountUser}
            updateAvailable={state.updateAvailable}
            onOpenUpdate={updater.open}
            onOpenSettings={() => {
              accountLoginAutoStartRef.current = false
              settingsTabRef.current = "general"
              dispatch({ type: "TOGGLE_SYSTEM_SETTINGS" })
            }}
            onOpenAccount={() => {
              accountLoginAutoStartRef.current = true
              settingsTabRef.current = "account"
              dispatch({ type: "TOGGLE_SYSTEM_SETTINGS" })
            }}
            onToggleTheme={() => {
              const settings = {
                ...state.systemSettings,
                theme: state.theme === "dark" ? "light" as const : "dark" as const,
              }
              dispatch({ type: "SET_SYSTEM_SETTINGS", settings })
              void persistSystemSettings(settings).catch((error) => {
                addLogLine(
                  "build",
                  `主题保存失败: ${error instanceof Error ? error.message : String(error)}`,
                  "error",
                )
              })
            }}
          />
          <AppWorkspace
            state={state}
            dispatch={dispatch}
            activeSessionRef={activeSessionRef}
            sessionsRef={sessionsRef}
            chat={chat}
            resize={resize}
            workflowNotifications={workflowNotifications}
            composerPreferences={composerPreferences}
            updateComposerPreferences={updateComposerPreferences}
            addLogLine={addLogLine}
          />
          <AppDialogs
            state={state}
            dispatch={dispatch}
            updaterState={updater.state}
            onCheckForUpdate={() => void updater.checkForUpdate(true)}
            onOpenUpdate={updater.open}
            settingsTabRef={settingsTabRef}
            accountLoginAutoStartRef={accountLoginAutoStartRef}
            onAccountChanged={onAccountChanged}
            activeSessionRef={activeSessionRef}
            setProjectEffectiveSettings={setProjectEffectiveSettings}
            persistSystemSettings={persistSystemSettings}
            addLogLine={addLogLine}
          />
          <UpdateDialog
            state={updater.state}
            onInstall={() => void updater.install()}
            onRetry={() => void updater.checkForUpdate(true)}
            onClose={updater.close}
          />
      </>
    </I18nProvider>
  )
}

async function persistSystemSettings(settings: SystemSettings): Promise<SystemSettings> {
  const response = await apiFetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  })
  const data = await response.json().catch(() => ({})) as {
    settings?: SystemSettings
    error?: string
  }
  if (!response.ok || !data.settings) throw new Error(data.error || `HTTP ${response.status}`)
  return data.settings
}
