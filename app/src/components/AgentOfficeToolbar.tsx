import { useI18n } from "../i18n"
import type { OfficeActivity, OfficeFestival } from "../office/types"
import {
  BarChartIcon,
  BellIcon,
  GaugeIcon,
  Maximize2Icon,
  Minimize2Icon,
  MoveIcon,
  PaintbrushIcon,
  RotateCcwIcon,
  Trash2Icon,
  TrophyIcon,
} from "./Icons"

type SideView = "employee" | "analytics" | "progress"

interface AgentOfficeToolbarProps {
  working: number
  standby: number
  resting: number
  needsYou: number
  currentAgent?: OfficeActivity
  contextPercent: number | null
  activeSessionId: string | null
  isStreaming: boolean
  sideView: SideView
  level: number
  researchPoints: number
  catalogOpen: boolean
  editMode: boolean
  festival: OfficeFestival
  ownsLunarFestival: boolean
  sound: boolean
  fullscreen: boolean
  onCompact: () => void
  onToggleAnalytics: () => void
  onToggleProgress: () => void
  onToggleCatalog: () => void
  onToggleEdit: () => void
  onResetLayout: () => void
  onFestival: (festival: OfficeFestival) => void
  onToggleSound: () => void
  onToggleFullscreen: () => void
}

export function AgentOfficeToolbar({
  working,
  standby,
  resting,
  needsYou,
  currentAgent,
  contextPercent,
  activeSessionId,
  isStreaming,
  sideView,
  level,
  researchPoints,
  catalogOpen,
  editMode,
  festival,
  ownsLunarFestival,
  sound,
  fullscreen,
  onCompact,
  onToggleAnalytics,
  onToggleProgress,
  onToggleCatalog,
  onToggleEdit,
  onResetLayout,
  onFestival,
  onToggleSound,
  onToggleFullscreen,
}: AgentOfficeToolbarProps) {
  const { t } = useI18n()

  return (
    <div className="office-toolbar">
      <div className="office-metric">
        <span className="office-dot working" />{t("office.working")} <strong>{working}</strong>
      </div>
      <div className="office-metric">
        <span className="office-dot standby" />{t("office.standby")} <strong>{standby}</strong>
      </div>
      <div className="office-metric">
        <span className="office-dot resting" />{t("office.resting")} <strong>{resting}</strong>
      </div>
      <div className="office-metric">
        <span className="office-dot attention" />{t("office.needsYou")} <strong>{needsYou}</strong>
      </div>
      {currentAgent && (
        <div className="office-route-chip" title={`Task ${currentAgent.runId}`}>
          {["resting", "completed", "failed"].includes(currentAgent.state)
            ? t("office.recent")
            : t("office.current")}
          {" · "}
          {currentAgent.agentName ?? currentAgent.agentId}
        </div>
      )}
      <div
        className={`office-context ${contextPercent !== null && contextPercent > 82 ? "high" : ""}`}
        title={contextPercent === null ? "" : `${contextPercent}%`}
      >
        <GaugeIcon size={12} />
        {t("office.token")}
        <span><i style={{ width: `${contextPercent === null ? 0 : 100 - contextPercent}%` }} /></span>
        <b>{contextPercent === null ? "--" : `${100 - contextPercent}%`}</b>
      </div>
      <button
        className="office-tool-button office-context-trash"
        onClick={onCompact}
        disabled={!activeSessionId || isStreaming}
        title="压缩上下文并清理 Token 垃圾"
      >
        <Trash2Icon size={13} />
      </button>
      <button
        className={`office-tool-button ${sideView === "analytics" ? "active" : ""}`}
        onClick={onToggleAnalytics}
        title="工作热力图与今日工具次数"
      >
        <BarChartIcon size={13} />
      </button>
      <button
        className={`office-progress-chip ${sideView === "progress" ? "active" : ""}`}
        onClick={onToggleProgress}
        title="办公室成长与奖励"
      >
        <TrophyIcon size={12} />Lv.{level}<span>{researchPoints}</span>
      </button>
      <button
        className={`office-tool-button ${catalogOpen ? "active" : ""}`}
        onClick={onToggleCatalog}
        title="办公室主题包"
      >
        <PaintbrushIcon size={13} />
      </button>
      <button
        className={`office-tool-button ${editMode ? "active" : ""}`}
        onClick={onToggleEdit}
        title="编辑办公室布局"
      >
        <MoveIcon size={13} />
      </button>
      {editMode && (
        <button className="office-tool-button" onClick={onResetLayout} title="恢复默认布局">
          <RotateCcwIcon size={13} />
        </button>
      )}
      <select
        className="office-festival-select"
        value={festival}
        onChange={(event) => onFestival(event.target.value as OfficeFestival)}
        title="节日主题"
      >
        <option value="auto">{t("office.theme.auto")}</option>
        <option value="none">{t("office.theme.none")}</option>
        <option value="spring">{t("office.theme.spring")}</option>
        <option value="summer">{t("office.theme.summer")}</option>
        <option value="autumn">{t("office.theme.autumn")}</option>
        <option value="winter">{t("office.theme.winter")}</option>
        <option value="lunar" disabled={!ownsLunarFestival}>
          {t("office.theme.lunar")}{ownsLunarFestival ? "" : t("office.theme.storeOnly")}
        </option>
      </select>
      <button
        className={`office-tool-button ${sound ? "active" : ""}`}
        onClick={onToggleSound}
        title={sound ? "关闭完成提示音" : "开启完成提示音"}
      >
        <BellIcon size={13} />
      </button>
      <button
        className="office-tool-button"
        onClick={onToggleFullscreen}
        title={fullscreen ? "退出全屏办公室" : "进入全屏办公室"}
      >
        {fullscreen ? <Minimize2Icon size={13} /> : <Maximize2Icon size={13} />}
      </button>
    </div>
  )
}
