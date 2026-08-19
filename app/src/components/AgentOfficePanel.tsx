import { useCallback, useEffect, useMemo, useState } from "react"
import type { AgentInfo } from "../types"
import { apiFetch } from "../api"
import { getOfficeSnapshot, publishOfficeActivity, subscribeOffice } from "../office/office-events"
import { applyAmbientSchedule } from "../office/office-ambient"
import { loadOfficeEntitlements, ownedOfficeFurnitureIds, ownsOfficePack, subscribeOfficeEntitlements } from "../office/office-entitlements"
import { findFurnitureSpace } from "../office/office-furniture"
import { officeThemePack, resolveOfficeScenePositions } from "../office/office-packs"
import { resolveOfficeObstacles, resolvePlacedFurnitureObstacles } from "../office/office-navigation"
import { resolveSceneObjectObstacles } from "../office/office-scene-objects"
import { clearOfficeStorePreviewPack, loadOfficeStorePreviewPack } from "../office/office-store"
import { officePersona, withOfficePersona } from "../office/office-personas"
import { agentColor, displayActivity } from "../office/office-model"
import { assignOfficeLabSeat, assignOfficeSeats, resolveOfficeSeatObstacles } from "../office/office-seats"
import {
  addOfficeFurniture, loadOfficePreferences, moveOfficeFurniture, officeDayPhase, removeOfficeFurniture,
  resetOfficeLayout, resolveFestival, saveOfficePreferences, setActiveOfficePack, setAgentAppearance,
  setAgentPosition, setZonePosition,
} from "../office/office-preferences"
import { getOfficeStats } from "../office/office-stats"
import {
  earnedOfficeFurnitureIds, loadOfficeProgression, officeLevel,
  subscribeOfficeProgression, type OfficeCompletionReward,
} from "../office/office-progression"
import { ZONE_PROMPTS, type OfficeZoneAction } from "../office/office-zones"
import type { OfficeActivity, OfficeAppearance, OfficePreferences, OfficeSnapshot } from "../office/types"
import { ActivityIcon, AlertCircleIcon, MoveIcon, SparklesIcon } from "./Icons"
import { AgentOfficeAvatar, type OfficeInteractionPhase } from "./AgentOfficeAvatar"
import { AgentOfficeToolbar } from "./AgentOfficeToolbar"
import { OfficeAnalytics } from "./OfficeAnalytics"
import { OfficeChairLayer } from "./OfficeChairLayer"
import { OfficeEmployeePanel } from "./OfficeEmployeePanel"
import { OfficeFurnitureLayer } from "./OfficeFurnitureLayer"
import { OfficeInventoryBar } from "./OfficeInventoryBar"
import { OfficeOcclusionLayer } from "./OfficeOcclusionLayer"
import { OfficeProgressPanel } from "./OfficeProgressPanel"
import { OfficeThemeCatalog } from "./OfficeThemeCatalog"
import { OfficeWorkstationLayer } from "./OfficeWorkstationLayer"
import { OfficeZoneLayer } from "./OfficeZoneLayer"
import { OfficeSceneObjectLayer } from "./OfficeSceneObjectLayer"
import "../office/office.css"
import { useI18n } from "../i18n"
import { useOfficeRuntimeSync } from "./useOfficeRuntimeSync"

interface Props {
  activeSessionId: string | null
  agents: AgentInfo[]
  contextUsage: { used: number; total: number } | null
  isStreaming: boolean
  onSend: (text: string, scope?: "auto-edit" | "full-access", agentId?: string) => void
  onStop: () => void
  onCompact: () => void
}

export function AgentOfficePanel({ activeSessionId, agents, contextUsage, isStreaming, onSend, onStop, onCompact }: Props) {
  const { language, t } = useI18n()
  const [snapshot, setSnapshot] = useState<OfficeSnapshot>(() => getOfficeSnapshot())
  const [preferences, setPreferences] = useState<OfficePreferences>(() => loadOfficePreferences())
  const [now, setNow] = useState(Date.now())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sideView, setSideView] = useState<"employee" | "analytics" | "progress">("employee")
  const [editMode, setEditMode] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [previewPackId, setPreviewPackId] = useState<string | null>(() => loadOfficeStorePreviewPack())
  const [fullscreen, setFullscreen] = useState(false)
  const [selectedFurniture, setSelectedFurniture] = useState<string | null>(null)
  const [notice, setNotice] = useState("")
  const [sound, setSound] = useState(() => localStorage.getItem("eval_office_sound") === "1")
  const [entitlements, setEntitlements] = useState(() => loadOfficeEntitlements())
  const [progression, setProgression] = useState(() => loadOfficeProgression())
  const [reward, setReward] = useState<(OfficeCompletionReward & { agentName: string }) | null>(null)
  const [avatarPhases, setAvatarPhases] = useState<Record<string, OfficeInteractionPhase>>({})
  const handleAvatarPhase = useCallback((runId: string, phase: OfficeInteractionPhase) => {
    setAvatarPhases((current) => current[runId] === phase ? current : { ...current, [runId]: phase })
  }, [])
  const officeAgents = useMemo<AgentInfo[]>(() => agents.length > 0 ? agents : [{
    id: "general", name: "通用助手", description: "通用数字员工", mode: "primary", color: "#5eead4", tools: [], source: "builtin",
  }], [agents])

  useEffect(() => subscribeOffice(setSnapshot), [])
  useEffect(() => subscribeOfficeEntitlements(() => setEntitlements(loadOfficeEntitlements())), [])
  useEffect(() => subscribeOfficeProgression(() => setProgression(loadOfficeProgression())), [])
  useEffect(() => {
    if (!fullscreen) return
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false) }
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [fullscreen])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer) }, [])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2_400); return () => clearTimeout(timer) }, [notice])
  useEffect(() => { if (!reward) return; const timer = setTimeout(() => setReward(null), 2_850); return () => clearTimeout(timer) }, [reward])
  const liveAgents = useMemo(
    () => snapshot.agents
      .filter((agent) => !activeSessionId || agent.sessionId === activeSessionId)
      .filter((agent) => !["completed", "resting", "failed"].includes(agent.state) || now - agent.timestamp < 90_000)
      .map((agent) => withOfficePersona(displayActivity(agent, now), officeAgents.find((item) => item.id === agent.agentId)?.name)),
    [activeSessionId, now, officeAgents, snapshot.agents],
  )
  const visibleAgents = useMemo(() => {
    const activeIds = new Set(liveAgents.map((agent) => agent.agentId))
    const rosterSource = officeAgents.filter((agent) => !activeIds.has(agent.id) && !["title-gen", "summary-gen"].includes(agent.id)).slice(0, 8)
    const roster = rosterSource.map((agent, index): OfficeActivity => {
      const persona = officePersona(agent.id, agent.name)
      return {
        runId: `roster-${agent.id}`, sessionId: activeSessionId ?? "office-lobby", agentId: agent.id,
        agentName: persona.name, agentRole: persona.role,
        state: "standby", activity: ["等待新任务", "整理工位", "检查工具箱", "阅读团队动态"][index % 4], timestamp: now,
        synthetic: true,
      }
    })
    return applyAmbientSchedule([...liveAgents, ...roster].slice(0, 14), now)
  }, [activeSessionId, liveAgents, now, officeAgents])

  useOfficeRuntimeSync({
    activeSessionId,
    agents,
    visibleAgents,
    sound,
    onReward: setReward,
  })

  const selected = visibleAgents.find((agent) => agent.runId === selectedId) ?? visibleAgents[0]
  const timeline = snapshot.timeline
    .filter((item) => !activeSessionId || item.sessionId === activeSessionId)
    .slice(0, 5)
    .map((item) => withOfficePersona(item, officeAgents.find((agent) => agent.id === item.agentId)?.name))
  const realAgents = liveAgents.filter((agent) => !agent.synthetic)
  const working = realAgents.filter((agent) => !["standby", "resting", "completed", "failed"].includes(agent.state)).length
  const resting = realAgents.filter((agent) => ["resting", "completed"].includes(agent.state)).length
  const standby = visibleAgents.filter((agent) => agent.synthetic).length
  const needsYou = realAgents.filter((agent) => agent.state === "waiting-human").length
  const failed = realAgents.filter((agent) => agent.state === "failed")
  const contextPercent = contextUsage ? Math.min(100, Math.round(contextUsage.used / Math.max(1, contextUsage.total) * 100)) : null
  const currentAgent = [...realAgents].sort((a, b) => b.timestamp - a.timestamp)[0]
  const stats = useMemo(() => getOfficeStats(), [snapshot.timeline.length])
  const ownsLunarFestival = entitlements.ownedLayoutIds.includes("lunar-festival")
  const festival = resolveFestival(preferences.festival, new Date(now), ownsLunarFestival)
  const phase = officeDayPhase(new Date(now))
  const savedPackId = ownsOfficePack(entitlements, preferences.activePackId) ? preferences.activePackId : "classic"
  const activePack = officeThemePack(previewPackId ?? savedPackId)
  const scenePositions = useMemo(
    () => resolveOfficeScenePositions(activePack, preferences.zonePositions),
    [activePack, preferences.zonePositions],
  )
  const sceneObstacles = useMemo(
    () => resolveOfficeObstacles(activePack.obstacles, scenePositions),
    [activePack.obstacles, scenePositions],
  )
  const objectObstacles = useMemo(
    () => resolveSceneObjectObstacles(activePack.sceneObjects ?? [], scenePositions),
    [activePack.sceneObjects, scenePositions],
  )
  const navigationBarriers = useMemo(
    () => resolveOfficeObstacles(activePack.navigationBarriers ?? [], scenePositions),
    [activePack.navigationBarriers, scenePositions],
  )
  const seatObstacles = useMemo(() => resolveOfficeSeatObstacles(scenePositions), [scenePositions])
  const navigationObstacles = useMemo(
    () => [
      ...sceneObstacles,
      ...objectObstacles,
      ...navigationBarriers,
      ...seatObstacles,
      ...resolvePlacedFurnitureObstacles(preferences.furniture),
    ],
    [navigationBarriers, objectObstacles, preferences.furniture, sceneObstacles, seatObstacles],
  )
  const physicalSeats = useMemo(
    () => ({ ...assignOfficeSeats(visibleAgents, scenePositions), ...assignOfficeLabSeat(visibleAgents, scenePositions) }),
    [scenePositions, visibleAgents],
  )
  const earnedFurniture = earnedOfficeFurnitureIds(progression)
  const ownedFurniture = Array.from(new Set([...ownedOfficeFurnitureIds(entitlements), ...earnedFurniture]))
  const visibleFurnitureIds = Array.from(new Set([...activePack.includedFurnitureIds, ...ownedFurniture]))

  const updatePreferences = (next: OfficePreferences) => {
    try { saveOfficePreferences(next); setPreferences(next) } catch { setNotice("设置太大，头像请换成更小的图片") }
  }
  const sendOffice = (text: string, scope: "auto-edit" | "full-access" = "auto-edit", agentId?: string) => {
    if (!isStreaming) { onSend(text, scope, agentId); return }
    onStop()
    setNotice("已中止当前轮次并提交新指令")
    setTimeout(() => onSend(text, scope, agentId), 80)
  }
  const appearance = (agentId?: string): OfficeAppearance => {
    const stored = agentId && preferences.appearances[agentId] || { outfit: "casual" as const }
    return entitlements.ownedOutfitIds.includes(stored.outfit) ? stored : { ...stored, outfit: "casual" }
  }
  const handleZone = (action: OfficeZoneAction) => {
    if (action === "compile" || action === "printer") return
    if (action === "coffee") {
      if (!selected || !["resting", "completed"].includes(selected.state)) { setNotice("这位员工正忙，稍后再请咖啡"); return }
      publishOfficeActivity({ ...selected, state: "resting", activity: "咖啡机出杯，算力恢复中", timestamp: Date.now() })
      setNotice("咖啡已送达")
      return
    }
    const prompt = ZONE_PROMPTS[action]
    if (prompt) sendOffice(prompt, "auto-edit")
  }
  const cancelTask = async (activity: OfficeActivity) => {
    const response = await apiFetch("/api/tasks/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: activity.runId }) }).catch(() => null)
    onStop()
    publishOfficeActivity({ ...activity, state: "resting", activity: "任务已中止，回休息区待命", timestamp: Date.now() })
    setNotice(response?.ok ? "任务已中止" : "当前任务链已中止")
  }
  const addFurniture = (itemId: string) => {
    const point = findFurnitureSpace(preferences.furniture, itemId)
    if (!point) { setNotice("这里已经太拥挤，请先移动或移除一件家具"); return }
    const instanceId = `${itemId}-${Date.now().toString(36)}`
    updatePreferences(addOfficeFurniture(preferences, { instanceId, itemId, ...point, rotation: 0 }))
    setSelectedFurniture(instanceId)
  }

  return (
    <section className={`agent-office festival-${festival} office-time-${phase} ${activePack.sceneObjects?.length ? "modular-scene" : "legacy-scene"} ${editMode ? "layout-edit-mode" : ""} ${fullscreen ? "office-fullscreen" : ""}`} aria-label={t("bottom.office")}
      style={{ "--office-pack-dark": `url(${activePack.assets.dark})`, "--office-pack-light": `url(${activePack.assets.light})`, "--office-accent": activePack.accent } as React.CSSProperties}>
      <AgentOfficeToolbar
        working={working}
        standby={standby}
        resting={resting}
        needsYou={needsYou}
        currentAgent={currentAgent}
        contextPercent={contextPercent}
        activeSessionId={activeSessionId}
        isStreaming={isStreaming}
        sideView={sideView}
        level={officeLevel(progression.xp)}
        researchPoints={progression.researchPoints}
        catalogOpen={catalogOpen}
        editMode={editMode}
        festival={preferences.festival}
        ownsLunarFestival={ownsLunarFestival}
        sound={sound}
        fullscreen={fullscreen}
        onCompact={onCompact}
        onToggleAnalytics={() => setSideView(sideView === "analytics" ? "employee" : "analytics")}
        onToggleProgress={() => setSideView(sideView === "progress" ? "employee" : "progress")}
        onToggleCatalog={() => setCatalogOpen(!catalogOpen)}
        onToggleEdit={() => setEditMode(!editMode)}
        onResetLayout={() => updatePreferences(resetOfficeLayout(preferences))}
        onFestival={(festival) => updatePreferences({ ...preferences, festival })}
        onToggleSound={() => {
          const next = !sound
          setSound(next)
          localStorage.setItem("eval_office_sound", next ? "1" : "0")
        }}
        onToggleFullscreen={() => setFullscreen(!fullscreen)}
      />
      <div className="office-stage">
        <div className="office-scene" /><div className="office-light-overlay" /><div className="office-festival-overlay" />
        <OfficeSceneObjectLayer
          objects={activePack.sceneObjects ?? []}
          positions={scenePositions}
          editMode={editMode}
          onMove={(id, point) => updatePreferences(setZonePosition(preferences, id, point))}
        />
        <OfficeWorkstationLayer
          agents={officeAgents}
          activities={liveAgents}
          editMode={editMode}
          positions={scenePositions}
          onMove={(id, point) => updatePreferences(setZonePosition(preferences, id, point))}
          onSelectAgent={(agentId) => {
            const target = visibleAgents.find((agent) => agent.agentId === agentId)
            if (target) { setSelectedId(target.runId); setSideView("employee") }
          }}
        />
        <OfficeZoneLayer editMode={editMode} positions={scenePositions} onMove={(id, point) => updatePreferences(setZonePosition(preferences, id, point))} onAction={handleZone} />
        <OfficeFurnitureLayer placements={preferences.furniture} editMode={editMode} selectedId={selectedFurniture} onSelect={setSelectedFurniture}
          onMove={(id, point) => updatePreferences(moveOfficeFurniture(preferences, id, point))} onInvalid={() => setNotice("家具不能重叠，也不能挡住办公室边缘")} />
        <OfficeChairLayer assignments={Object.values(physicalSeats)} phases={avatarPhases} positions={scenePositions} editMode={editMode} />
        {visibleAgents.map((agent, index) => <AgentOfficeAvatar key={`${agent.sessionId}:${agent.runId}`} agent={agent} ordinal={index} selected={selected?.runId === agent.runId} appearance={appearance(agent.agentId)} customPosition={preferences.positions[agent.agentId]} workstationPositions={scenePositions} seat={physicalSeats[agent.runId]} navigationObstacles={navigationObstacles} editMode={editMode} onPhaseChange={handleAvatarPhase} onSelect={() => { setSelectedId(agent.runId); setSideView("employee") }} onMove={(point) => updatePreferences(setAgentPosition(preferences, agent.agentId, point))} />)}
        <OfficeOcclusionLayer obstacles={sceneObstacles} />
        {editMode && <OfficeInventoryBar itemIds={visibleFurnitureIds} ownedItemIds={ownedFurniture} selectedId={selectedFurniture} onAdd={addFurniture} onRemove={(id) => { updatePreferences(removeOfficeFurniture(preferences, id)); setSelectedFurniture(null) }} />}
        {editMode && <div className="office-layout-hint"><MoveIcon size={12} />拖动员工、工位、功能区或家具，布局会自动保存</div>}
        {catalogOpen && <OfficeThemeCatalog activePackId={savedPackId} previewPackId={previewPackId} entitlements={entitlements}
          onSelect={(id) => { updatePreferences(setActiveOfficePack(preferences, id)); clearOfficeStorePreviewPack(); setPreviewPackId(null); setCatalogOpen(false); setNotice("办公室主题已启用") }}
          onPreview={(id) => { setPreviewPackId(id); setNotice("正在试玩主题；关闭应用后不会保存") }} onClose={() => setCatalogOpen(false)} />}
        {failed.length > 0 && <button className="office-failure-alarm" onClick={() => { setSelectedId(failed[0].runId); setSideView("employee") }}><AlertCircleIcon size={13} />故障警报 · {failed.length}</button>}
        {notice && <div className="office-notice">{notice}</div>}
        {reward && <div className="office-reward-burst"><SparklesIcon size={25} /><strong>{reward.agentName} 完成交付</strong><span>+{reward.xp} XP · +{reward.researchPoints} 研发点{reward.levelAfter > reward.levelBefore ? ` · 升到 Lv.${reward.levelAfter}` : ""}</span></div>}
      </div>
      <aside className="office-sidecar">
        {sideView === "analytics" ? <OfficeAnalytics stats={stats} /> : sideView === "progress" ? <OfficeProgressPanel progress={progression} /> : <>
          <OfficeEmployeePanel selected={selected} agents={agents} appearance={appearance(selected?.agentId)} ownedOutfitIds={entitlements.ownedOutfitIds} now={now} onAppearance={(next) => selected && updatePreferences(setAgentAppearance(preferences, selected.agentId, next))} onCancel={cancelTask} onFollowup={(activity, text) => sendOffice(activity.synthetic ? text : `继续处理当前任务并回答：${text}`, "auto-edit", activity.agentId)} onReassign={(activity, targetId) => { const target = agents.find((agent) => agent.id === targetId); sendOffice(`接手任务“${activity.activity}”，先汇报执行计划再继续。`, "auto-edit", target?.id ?? targetId) }} />
          <div className="office-timeline-title"><ActivityIcon size={12} />{t("office.activity")}</div>
          <div className="office-timeline">{timeline.map((item, index) => <div key={`${item.runId}-${item.timestamp}-${index}`}><i style={{ background: agentColor(item.agentId) }} /><span><b>{item.agentName ?? item.agentId}</b>{item.activity}</span><time>{new Date(item.timestamp).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}</time></div>)}{timeline.length === 0 && <span className="office-timeline-empty">{t("office.waiting")}</span>}</div>
        </>}
      </aside>
    </section>
  )
}
