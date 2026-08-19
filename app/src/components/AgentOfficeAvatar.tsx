import { useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import type { OfficeActivity, OfficeAppearance, OfficePoint } from "../office/types"
import { ambientLabel } from "../office/office-ambient"
import { resolveCharacterMotion } from "../office/office-character-state"
import { officeCharacterProfile } from "../office/office-characters"
import { agentColor, agentPosition, isWorkstationActivity, stateLabel } from "../office/office-model"
import {
  isOfficePointWalkable, nearestWalkablePoint, OFFICE_AGENT_RADIUS, OFFICE_WALK_SPEED, officeSpawnPoint,
  planOfficeRoute, routeDirection, type OfficeObstacle,
} from "../office/office-navigation"
import { navigationObstaclesForSeat, type OfficeSeatAssignment } from "../office/office-seats"
import { officeAvatarZIndex } from "../office/office-layering"
import {
  loadOfficeAvatarRuntime,
  saveOfficeAvatarRuntime,
  type OfficeAvatarDirection,
  type OfficeAvatarRuntimePhase,
} from "../office/office-avatar-runtime"
import { BookOpenIcon, Code2Icon, CoffeeIcon, CopyIcon, MessageSquareIcon, MoveIcon } from "./Icons"

interface Props {
  agent: OfficeActivity
  ordinal: number
  selected: boolean
  appearance: OfficeAppearance
  customPosition?: OfficePoint
  workstationPositions: Record<string, OfficePoint>
  seat?: OfficeSeatAssignment
  navigationObstacles: OfficeObstacle[]
  editMode: boolean
  onPhaseChange?: (runId: string, phase: OfficeInteractionPhase) => void
  onSelect: () => void
  onMove: (point: OfficePoint) => void
}

export type OfficeInteractionPhase = OfficeAvatarRuntimePhase

export function AgentOfficeAvatar({ agent, ordinal, selected, appearance, customPosition, workstationPositions, seat, navigationObstacles, editMode, onPhaseChange, onSelect, onMove }: Props) {
  const ambientAction = agent.state === "standby" ? agent.ambientAction : undefined
  const ambient = ambientLabel(ambientAction)
  const motion = resolveCharacterMotion(agent)
  const character = officeCharacterProfile(agent.agentId, appearance.characterId)
  const atHome = agent.state === "standby" && (!agent.ambientAction || agent.ambientAction === "idle" || agent.ambientAction === "computer")
  const needsWorkstation = isWorkstationActivity(agent)
  const atPhysicalSeat = Boolean(seat)
  const atWorkstation = seat?.kind === "workstation"
  const atLabStool = seat?.kind === "lab-stool"
  const routeObstacles = useMemo(
    () => navigationObstaclesForSeat(navigationObstacles, seat),
    [navigationObstacles, seat?.seatId],
  )
  const defaultPosition = seat
    ? { x: seat.x, y: seat.y, zone: seat.zone }
    : needsWorkstation
      ? { x: 28 + (ordinal % 6) * 9, y: 87, zone: "候补工位" }
      : agentPosition(agent, ordinal, workstationPositions)
  const validCustomPosition = customPosition && isOfficePointWalkable(customPosition, routeObstacles, undefined, OFFICE_AGENT_RADIUS)
  const position = validCustomPosition && (atHome || editMode)
    ? { ...customPosition, zone: "自定义固定工位" }
    : defaultPosition
  const [restoredRuntime] = useState(() => loadOfficeAvatarRuntime(agent.sessionId, agent.runId))
  const initialPosition = restoredRuntime?.position ?? officeSpawnPoint(agent.agentId)
  const [visualPosition, setVisualPosition] = useState<OfficePoint>(initialPosition)
  const [traveling, setTraveling] = useState(restoredRuntime?.traveling ?? false)
  const [direction, setDirection] = useState<OfficeAvatarDirection>(restoredRuntime?.direction ?? "front")
  const [gaitStep, setGaitStep] = useState<0 | 1>(restoredRuntime?.gaitStep ?? 0)
  const [interactionPhase, setInteractionPhase] = useState<OfficeInteractionPhase>(restoredRuntime?.phase ?? "walking")
  const currentPosition = useRef<OfficePoint>(initialPosition)
  const phaseRef = useRef<OfficeInteractionPhase>(restoredRuntime?.phase ?? "walking")
  const positionKey = `${position.x.toFixed(2)}:${position.y.toFixed(2)}`
  useEffect(() => {
    const target = { x: position.x, y: position.y }
    let frame = 0
    let transitionTimer = 0
    const changePhase = (phase: OfficeInteractionPhase) => {
      phaseRef.current = phase
      setInteractionPhase(phase)
      onPhaseChange?.(agent.runId, phase)
    }
    const finishArrival = () => {
      setTraveling(false)
      setGaitStep(0)
      if (!atPhysicalSeat) { changePhase("standing"); return }
      changePhase("aligning")
      transitionTimer = window.setTimeout(() => {
        setDirection("back")
        changePhase("turning")
        transitionTimer = window.setTimeout(() => {
          changePhase("sitting")
          transitionTimer = window.setTimeout(() => changePhase("seated"), 220)
        }, 180)
      }, 160)
    }
    if (editMode) {
      currentPosition.current = target
      setVisualPosition(target)
      setTraveling(false)
      changePhase("standing")
      return () => window.clearTimeout(transitionTimer)
    }

    if (Math.hypot(target.x - currentPosition.current.x, target.y - currentPosition.current.y) < .12) {
      setTraveling(false)
      setGaitStep(0)
      if (atPhysicalSeat) {
        setDirection("back")
        changePhase("seated")
      } else {
        changePhase("standing")
      }
      return () => window.clearTimeout(transitionTimer)
    }

    const beginWalking = () => {
      const current = currentPosition.current
      const currentWalkable = isOfficePointWalkable(current, routeObstacles)
      const routeStart = currentWalkable ? current : nearestWalkablePoint(current, routeObstacles)
      const route = [
        ...(!currentWalkable ? [routeStart] : []),
        ...planOfficeRoute(routeStart, target, { obstacles: routeObstacles }),
      ]
      if (route.length === 0) { finishArrival(); return }
      let segmentIndex = 0
      let segmentEnd = route[segmentIndex]
      let previousTime: number | null = null
      let lastPaint = 0
      let traveledDistance = 0
      let currentSpeed = 0
      setTraveling(true)
      changePhase("walking")
      setDirection(routeDirection(currentPosition.current, segmentEnd))

      const walk = (time: number) => {
        if (previousTime === null) previousTime = time
        const frameSeconds = Math.min(.05, (time - previousTime) / 1_000)
        previousTime = time
        const distanceToSegmentEnd = segmentEnd
          ? Math.hypot(segmentEnd.x - currentPosition.current.x, segmentEnd.y - currentPosition.current.y)
          : 0
        const distanceAfterSegment = route.slice(segmentIndex + 1).reduce((total, point, index) => {
          const previous = index === 0 ? segmentEnd : route[segmentIndex + index]
          return total + (previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0)
        }, 0)
        const routeRemaining = distanceToSegmentEnd + distanceAfterSegment
        const acceleration = 24
        currentSpeed = Math.min(OFFICE_WALK_SPEED, currentSpeed + acceleration * frameSeconds)
        const brakingSpeed = Math.sqrt(Math.max(0, 2 * acceleration * routeRemaining))
        let remaining = Math.min(currentSpeed, brakingSpeed) * frameSeconds
        if (routeRemaining < .08 && segmentEnd) remaining = routeRemaining

        while (segmentEnd && remaining > 0) {
          const from = currentPosition.current
          const distance = Math.hypot(segmentEnd.x - from.x, segmentEnd.y - from.y)
          if (distance < .01 || remaining >= distance) {
            currentPosition.current = { ...segmentEnd }
            remaining = Math.max(0, remaining - distance)
            traveledDistance += distance
            segmentIndex += 1
            segmentEnd = route[segmentIndex]
            if (segmentEnd) setDirection(routeDirection(currentPosition.current, segmentEnd))
            continue
          }
          const progress = remaining / distance
          traveledDistance += remaining
          currentPosition.current = {
            x: from.x + (segmentEnd.x - from.x) * progress,
            y: from.y + (segmentEnd.y - from.y) * progress,
          }
          remaining = 0
        }

        if (time - lastPaint >= 20 || !segmentEnd) {
          setVisualPosition({ ...currentPosition.current })
          setGaitStep(Math.floor(traveledDistance / 1.8) % 2 as 0 | 1)
          lastPaint = time
        }
        if (!segmentEnd) { finishArrival(); return }
        frame = window.requestAnimationFrame(walk)
      }
      frame = window.requestAnimationFrame(walk)
    }

    if (phaseRef.current === "seated") {
      changePhase("rising")
      setDirection("front")
      transitionTimer = window.setTimeout(beginWalking, 280)
    } else {
      changePhase("standing")
      const departureDelay = 80 + stableHash(agent.runId) % 5 * 110
      transitionTimer = window.setTimeout(beginWalking, departureDelay)
    }
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(transitionTimer)
    }
  }, [agent.runId, atPhysicalSeat, editMode, onPhaseChange, position.x, position.y, positionKey, routeObstacles])
  useEffect(() => {
    saveOfficeAvatarRuntime({
      sessionId: agent.sessionId,
      runId: agent.runId,
      position: visualPosition,
      target: { x: position.x, y: position.y },
      direction,
      gaitStep,
      phase: interactionPhase,
      traveling,
      updatedAt: Date.now(),
    })
  }, [
    agent.runId, agent.sessionId, direction, gaitStep, interactionPhase,
    position.x, position.y, traveling, visualPosition.x, visualPosition.y,
  ])
  const color = agentColor(agent.agentId)
  const visuallySeated = atPhysicalSeat && !traveling && !["standing", "walking"].includes(interactionPhase)
  const spritePose = resolveSpritePose(motion, traveling, direction, atPhysicalSeat, interactionPhase)
  const usesGeneratedSprite = !appearance.avatarDataUrl || spritePose === "seated-back"
  const gaitLegPose = gaitStep === 0
    ? (direction === "left" || direction === "back" ? "walk-left" : "walk-right")
    : (direction === "left" || direction === "back" ? "walk-right" : "walk-left")
  const move = (event: DragEvent<HTMLButtonElement>) => {
    if (!editMode) return
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!rect) return
    const requested = { x: (event.clientX - rect.left) / rect.width * 100, y: (event.clientY - rect.top) / rect.height * 100 }
    onMove(nearestWalkablePoint(requested, routeObstacles))
  }
  return (
    <button
      type="button"
      className={`office-avatar ${agent.state} motion-${motion} facing-${direction} phase-${interactionPhase} gait-${gaitStep} ${traveling ? "traveling" : "arrived"} ${atPhysicalSeat ? "at-physical-seat" : ""} ${atWorkstation ? "at-workstation" : ""} ${atLabStool ? "at-lab-stool" : ""} ${ambientAction ? `ambient-${ambientAction}` : ""} outfit-${appearance.outfit} ${usesGeneratedSprite ? "generated-sprite" : "custom-avatar"} ${selected ? "selected" : ""} ${editMode ? "layout-editing" : ""}`}
      style={{
        left: `${visualPosition.x}%`, top: `${visualPosition.y}%`,
        // A selected seated employee must remain behind the physical chair
        // back; otherwise selection would make the torso jump in front again.
        zIndex: officeAvatarZIndex(visualPosition.y, selected, visuallySeated),
        "--agent-color": color,
        "--character-sprite-light": `url("/office/characters/v2/${character.id}-light.png")`,
        "--character-sprite-dark": `url("/office/characters/v2/${character.id}-dark.png")`,
        "--character-seated-back": `url("/office/characters/v3/seated-back/${character.id}.png")`,
      } as React.CSSProperties}
      onClick={() => { if (!editMode) onSelect() }}
      draggable={editMode}
      onDragEnd={move}
      title={editMode ? `拖动调整 ${agent.agentName ?? agent.agentId} 的工位` : `${agent.agentName ?? agent.agentId} · ${ambient ?? stateLabel(agent.state)} · ${position.zone}`}
    >
      <span className={`office-speech ${ambientAction === "chatting" && agent.ambientSeat === 0 ? "ambient-auto-speech" : ""}`}>{editMode ? "拖我去新工位" : traveling ? `前往${position.zone}` : agent.activity}</span>
      {ambientAction && ambientAction !== "idle" && !editMode && <span className="office-ambient-prop" aria-hidden="true"><AmbientActionIcon action={ambientAction} /></span>}
      <span className="office-ground-shadow" aria-hidden="true" />
      {appearance.avatarDataUrl && spritePose !== "seated-back" ? (
        <span className="office-character office-custom-character" aria-hidden="true"><img src={appearance.avatarDataUrl} alt="" /><span className="office-character-shadow" /></span>
      ) : (
        <>
          <span className={`office-character office-generated-character office-gait-upper character-${character.id} sprite-${spritePose}`} aria-hidden="true" />
          {traveling && <span className={`office-character office-generated-character office-gait-lower gait-step-${gaitStep} character-${character.id} sprite-${gaitLegPose}`} aria-hidden="true" />}
        </>
      )}
      <span className="office-avatar-name">{agent.agentName ?? agent.agentId}</span>
      <span className="office-avatar-state">{editMode ? "布局编辑" : traveling ? `步行前往${position.zone}` : interactionPhase === "rising" ? "正在起身" : interactionPhase === "aligning" ? "椅前对位" : interactionPhase === "turning" ? "转身入座" : interactionPhase === "sitting" ? "正在坐下" : `${agent.agentRole ? `${agent.agentRole} · ` : ""}${ambient ?? stateLabel(agent.state)}`}</span>
    </button>
  )
}

function resolveSpritePose(motion: ReturnType<typeof resolveCharacterMotion>, traveling: boolean, direction: "left" | "right" | "front" | "back", atPhysicalSeat: boolean, phase: OfficeInteractionPhase): string {
  if (traveling || motion === "walk") return direction === "left" || direction === "back" ? "walk-left" : "walk-right"
  if (phase === "rising" || phase === "aligning" || phase === "turning" || phase === "sitting") return "stand"
  if (atPhysicalSeat && phase === "seated") return "seated-back"
  if (motion === "type") return "stand"
  if (motion === "read") return "read"
  if (motion === "carry") return "carry"
  if (motion === "rest") return "tea"
  if (motion === "celebrate") return "celebrate"
  return "stand"
}

function AmbientActionIcon({ action }: { action: NonNullable<OfficeActivity["ambientAction"]> }) {
  if (action === "tea") return <CoffeeIcon size={13} />
  if (action === "reading") return <BookOpenIcon size={13} />
  if (action === "copying") return <CopyIcon size={13} />
  if (action === "strolling") return <MoveIcon size={13} />
  if (action === "chatting") return <MessageSquareIcon size={13} />
  return <Code2Icon size={13} />
}

function stableHash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index++) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}
