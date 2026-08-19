import { describe, expect, test } from "bun:test"
import { officeDayPhase, resolveFestival } from "../src/office/office-preferences"
import { agentPosition, displayActivity, isWorkstationActivity, stateLabel } from "../src/office/office-model"
import { getOfficeSnapshot, publishOfficeActivity } from "../src/office/office-events"
import { agentHomePosition, agentWorkPosition, workstationIdForAgent } from "../src/office/office-workstations"
import { AMBIENT_INTERVAL_MS, ambientPosition, applyAmbientSchedule } from "../src/office/office-ambient"
import { officePersona, withOfficePersona } from "../src/office/office-personas"
import { INTERACTIVE_OFFICE_ZONES, ZONE_PROMPTS } from "../src/office/office-zones"

describe("office theme scheduling", () => {
  test("resolves explicit festival without date overrides", () => {
    expect(resolveFestival("lunar", new Date(2026, 6, 1))).toBe("lunar")
    expect(resolveFestival("none", new Date(2026, 0, 25))).toBe("none")
    expect(resolveFestival("lunar", new Date(2026, 0, 25), false)).toBe("none")
    expect(resolveFestival("auto", new Date(2026, 0, 25), false)).toBe("winter")
  })

  test("maps automatic seasonal themes", () => {
    expect(resolveFestival("auto", new Date(2026, 3, 1))).toBe("spring")
    expect(resolveFestival("auto", new Date(2026, 6, 1))).toBe("summer")
    expect(resolveFestival("auto", new Date(2026, 9, 1))).toBe("autumn")
    expect(resolveFestival("auto", new Date(2026, 11, 1))).toBe("winter")
    expect(resolveFestival("auto", new Date(2026, 0, 25))).toBe("lunar")
  })

  test("maps office day phases", () => {
    expect(officeDayPhase(new Date(2026, 6, 1, 9))).toBe("day")
    expect(officeDayPhase(new Date(2026, 6, 1, 19))).toBe("dusk")
    expect(officeDayPhase(new Date(2026, 6, 1, 2))).toBe("night")
  })

  test("keeps standby employees distributed without calling them resting", () => {
    const first = agentPosition({ runId: "roster-a", sessionId: "test", agentId: "a", state: "standby", activity: "待命", timestamp: 1, synthetic: true }, 0)
    const second = agentPosition({ runId: "roster-b", sessionId: "test", agentId: "b", state: "standby", activity: "待命", timestamp: 1, synthetic: true }, 1)
    expect(stateLabel("standby")).toBe("待命中")
    expect(first).not.toEqual(second)
  })

  test("deduplicates rapid polling updates for the same office state", () => {
    const before = getOfficeSnapshot().timeline.length
    const base = { runId: "dedupe-run", sessionId: "dedupe-session", agentId: "general", state: "thinking" as const, timestamp: 10_000 }
    publishOfficeActivity({ ...base, activity: "开始任务" })
    publishOfficeActivity({ ...base, activity: "正在处理任务", timestamp: 11_000 })
    expect(getOfficeSnapshot().timeline.length - before).toBe(1)
  })

  test("assigns built-in and custom agents to stable computer workstations", () => {
    expect(workstationIdForAgent("firmware-engineer")).toBe("desk-firmware")
    expect(workstationIdForAgent("software-engineer")).toBe("desk-software")
    expect(workstationIdForAgent("hardware-engineer")).toBe("desk-firmware")
    expect(workstationIdForAgent("future-agent")).not.toBeNull()
    expect(workstationIdForAgent("custom-protocol")).toBe(workstationIdForAgent("custom-protocol"))
    expect(workstationIdForAgent("custom-protocol")).not.toBeNull()
  })

  test("sends planning to the whiteboard while coding and compiling use the assigned workstation", () => {
    const workPosition = agentWorkPosition("software-engineer")
    const base = { runId: "work-run", sessionId: "test", agentId: "software-engineer", activity: "工作", timestamp: 1 }
    const thinking = { ...base, state: "thinking" as const }
    const editing = { ...base, state: "editing" as const, toolName: "edit" }
    const compiling = { ...base, state: "executing" as const, toolName: "compile" }
    expect(agentPosition(thinking, 0, { whiteboard: { x: 67, y: 28 } })).toEqual({ x: 62, y: 28, zone: "白板规划区" })
    expect(agentPosition(editing, 0)).toEqual(workPosition)
    expect(agentPosition(compiling, 0)).toEqual(workPosition)
    expect(isWorkstationActivity(thinking)).toBe(false)
    expect([editing, compiling].every(isWorkstationActivity)).toBe(true)
  })

  test("moves an agent home together with its workstation", () => {
    const base = agentHomePosition("firmware-engineer")
    const moved = agentHomePosition("firmware-engineer", 0, { "desk-firmware": { x: 59, y: 23 } })
    expect(moved.x - base.x).toBe(10)
    expect(moved.y - base.y).toBe(5)
  })

  test("returns a completed agent to its fixed workstation", () => {
    const activity = displayActivity({
      runId: "finished-run", sessionId: "test", agentId: "firmware-engineer", state: "completed", activity: "done", timestamp: 1_000,
    }, 10_000)
    expect(activity.state).toBe("standby")
    expect(agentPosition(activity, 0).zone).toContain("固件")
  })

  test("gives idle employees random-looking actions with frequent pauses", () => {
    const employee = { runId: "roster-general", sessionId: "test", agentId: "general", agentName: "通用助手", state: "standby" as const, activity: "待命", timestamp: 1, synthetic: true }
    const actions = Array.from({ length: 160 }, (_, step) => applyAmbientSchedule([employee], step * AMBIENT_INTERVAL_MS)[0].ambientAction)
    expect(new Set(actions)).toEqual(new Set(["idle", "computer", "tea", "reading", "copying", "strolling"]))
    expect(actions.filter((action) => action === "idle").length).toBeGreaterThan(actions.filter((action) => action === "strolling").length)
  })

  test("occasionally pairs idle employees for a project chat on the sofa", () => {
    const employees = ["a", "b", "c", "d"].map((id) => ({ runId: `roster-${id}`, sessionId: "test", agentId: id, agentName: id.toUpperCase(), state: "standby" as const, activity: "待命", timestamp: 1, synthetic: true }))
    const snapshots = Array.from({ length: 80 }, (_, step) => applyAmbientSchedule(employees, step * AMBIENT_INTERVAL_MS))
    const conversation = snapshots.find((snapshot) => snapshot.filter((employee) => employee.ambientAction === "chatting").length === 2)
    expect(conversation).toBeDefined()
    const chatting = conversation!.filter((employee) => employee.ambientAction === "chatting")
    expect(chatting[0].activity).toContain("讨论")
    expect(ambientPosition(chatting[0], 0, {}).zone).toBe("休息区沙发")
    expect(ambientPosition(chatting[0], 0, {})).not.toEqual(ambientPosition(chatting[1], 1, {}))
  })

  test("does not expose compile or printer as accidental LLM buttons", () => {
    expect(INTERACTIVE_OFFICE_ZONES.map((zone) => zone.id)).not.toContain("compile")
    expect(INTERACTIVE_OFFICE_ZONES.map((zone) => zone.id)).not.toContain("printer")
    expect(ZONE_PROMPTS.compile).toBeUndefined()
    expect(ZONE_PROMPTS.printer).toBeUndefined()
  })

  test("never replaces a real working state with an idle activity", () => {
    const working = { runId: "real-run", sessionId: "test", agentId: "firmware-dev", state: "editing" as const, activity: "修改固件", timestamp: 1 }
    expect(applyAmbientSchedule([working], 999_999)[0]).toEqual(working)
  })

  test("gives office characters cute names while preserving their professional roles", () => {
    expect(officePersona("firmware-engineer", "固件工程师")).toEqual({ name: "芯仔", role: "固件工程师" })
    expect(officePersona("software-engineer", "软件工程师")).toEqual({ name: "码可", role: "软件工程师" })
    const activity = withOfficePersona({ runId: "run", sessionId: "test", agentId: "test-engineer", agentName: "测试工程师", state: "executing", activity: "测试", timestamp: 1 })
    expect(activity.agentName).toBe("点点")
    expect(activity.agentRole).toBe("测试工程师")
  })

  test("assigns unknown custom agents a stable friendly name", () => {
    expect(officePersona("custom-protocol", "协议工程师")).toEqual(officePersona("custom-protocol", "协议工程师"))
    expect(officePersona("custom-protocol", "协议工程师").name).not.toContain("工程师")
  })
})
