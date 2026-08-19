import type { OfficeActivity } from "./types"
import { isWorkstationActivity } from "./office-model"

export type OfficeCharacterMotion = "idle" | "walk" | "type" | "read" | "carry" | "talk" | "focus" | "celebrate" | "alert" | "rest"

export function resolveCharacterMotion(agent: OfficeActivity): OfficeCharacterMotion {
  if (agent.state === "failed" || agent.state === "waiting-human") return "alert"
  if (agent.state === "completed") return "celebrate"
  if (agent.state === "resting") return "rest"
  if (agent.state !== "standby") {
    if (agent.state === "reading") return "read"
    if (agent.state === "editing" || isWorkstationActivity(agent)) return "type"
    if (agent.state === "executing" && agent.toolName === "write_office") return "carry"
    if (agent.state === "executing") return "focus"
    if (agent.state === "collaborating") return "talk"
    return "focus"
  }
  if (agent.ambientAction === "strolling") return "walk"
  if (agent.ambientAction === "reading") return "read"
  if (agent.ambientAction === "copying") return "carry"
  if (agent.ambientAction === "chatting") return "talk"
  if (agent.ambientAction === "computer") return "type"
  if (agent.ambientAction === "tea") return "rest"
  return "idle"
}
