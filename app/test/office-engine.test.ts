import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveCharacterMotion } from "../src/office/office-character-state"
import { applyAmbientSchedule } from "../src/office/office-ambient"
import { officeAvatarZIndex, officeChairPose, officeChairZIndex, officeSceneFrontZIndex } from "../src/office/office-layering"
import { canPlaceFurniture, findFurnitureSpace } from "../src/office/office-furniture"
import { agentPosition, isWorkstationActivity } from "../src/office/office-model"
import { officeThemePack, resolveOfficeScenePositions } from "../src/office/office-packs"
import { isOfficePointWalkable, resolveOfficeObstacles } from "../src/office/office-navigation"
import { resolveSceneObjectObstacles } from "../src/office/office-scene-objects"
import { officeCharacterProfile } from "../src/office/office-characters"
import { assignOfficeLabSeat, assignOfficeSeats, navigationObstaclesForSeat, officeSeatPoint, resolveOfficeSeatObstacles } from "../src/office/office-seats"
import { grantFreeOfficeProduct, OFFICE_STORE_PRODUCTS, ownsOfficeProduct } from "../src/office/office-store"
import type { OfficeActivity, OfficeFurniturePlacement } from "../src/office/types"
import type { OfficeEntitlements } from "../src/office/office-entitlements"

const APP_ROOT = existsSync(join(process.cwd(), "public")) ? process.cwd() : join(process.cwd(), "app")

function activity(overrides: Partial<OfficeActivity> = {}): OfficeActivity {
  return {
    runId: "run-1", sessionId: "session-1", agentId: "general", state: "standby",
    activity: "等待新任务", timestamp: 1, ...overrides,
  }
}

describe("Office Engine 2.0", () => {
  test("主题包同时提供 light 和 dark 资源与独立锚点", () => {
    const pack = officeThemePack("aurora-lab")
    expect(pack.assets.dark).toContain("aurora-lab-dark")
    expect(pack.assets.light).toContain("aurora-lab-light")
    expect(pack.anchors["desk-project"].x).not.toBe(officeThemePack("classic").anchors["desk-project"].x)
    expect(pack.anchors.whiteboard.x).not.toBe(officeThemePack("classic").anchors.whiteboard.x)
  })

  test("经典办公室的可见家具均为独立资产并携带物理边界", () => {
    const objects = officeThemePack("classic").sceneObjects ?? []
    const physical = objects.filter((object) => object.kind !== "rug" && object.kind !== "wall")
    expect(physical.length).toBeGreaterThanOrEqual(8)
    for (const object of physical) {
      expect(object.footprint, object.id).toBeDefined()
      expect(object.asset?.light, object.id).toBeDefined()
      const assetPath = join(APP_ROOT, "public", object.asset!.light.replace(/^\//, ""))
      expect(existsSync(assetPath), assetPath).toBe(true)
    }
  })

  test("默认办公室不显示容易误认为碰撞阴影的占地区域地毯", () => {
    const objects = officeThemePack("classic").sceneObjects ?? []
    expect(objects.some((object) => object.kind === "rug")).toBe(false)
    expect(officeThemePack("classic").anchors["meeting-rug"]).toBeUndefined()
    expect(officeThemePack("classic").anchors["lounge-rug"]).toBeUndefined()
  })

  test("实验台、原理图桌和会议桌的完整桌面投影均不可行走", () => {
    const pack = officeThemePack("classic")
    const obstacles = resolveSceneObjectObstacles(pack.sceneObjects ?? [], pack.anchors)
    for (const id of ["lab", "schematic", "meeting-table"]) {
      const anchor = pack.anchors[id]
      const obstacle = obstacles.find((value) => value.id === `scene:${id}`)!
      expect(obstacle.y, id).toBeLessThan(anchor.y - 15)
      expect(isOfficePointWalkable({ x: anchor.x, y: anchor.y - 12 }, obstacles), id).toBe(false)
    }
  })

  test("所有工位椅和实验凳都是物理障碍，仅对自己的入座路径开放", () => {
    const anchors = officeThemePack("classic").anchors
    const obstacles = resolveOfficeSeatObstacles(anchors)
    expect(obstacles).toHaveLength(4)
    const worker = activity({ state: "editing", toolName: "edit" })
    const seat = assignOfficeSeats([worker], anchors)[worker.runId]
    const routed = navigationObstaclesForSeat(obstacles, seat)
    expect(routed.some((value) => value.id === `seat:${seat.seatId}`)).toBe(false)
    expect(routed).toHaveLength(3)
    expect(isOfficePointWalkable(officeSeatPoint("desk-software", anchors), routed)).toBe(false)
  })

  test("GIF 或 WebP 环境循环不会附着到有物理碰撞的家具", () => {
    const objects = officeThemePack("classic").sceneObjects ?? []
    const animatedPhysical = objects.filter((object) => object.footprint && object.asset?.ambientMotion)
    expect(animatedPhysical).toEqual([])
  })

  test("角色状态机优先映射真实任务状态", () => {
    expect(resolveCharacterMotion(activity({ state: "executing", ambientAction: "tea" }))).toBe("type")
    expect(resolveCharacterMotion(activity({ state: "waiting-human" }))).toBe("alert")
    expect(resolveCharacterMotion(activity({ state: "completed" }))).toBe("celebrate")
  })

  test("真实任务会清除历史摸鱼状态，不再携带游荡目的地或休闲道具", () => {
    const working = activity({
      state: "executing",
      toolName: "compile",
      ambientAction: "tea",
      ambientStep: 4,
      ambientSeat: 1,
    })
    expect(applyAmbientSchedule([working], Date.now())[0]).toMatchObject({
      state: "executing",
      toolName: "compile",
    })
    expect(applyAmbientSchedule([working], Date.now())[0].ambientAction).toBeUndefined()
    expect(applyAmbientSchedule([working], Date.now())[0].ambientStep).toBeUndefined()
    expect(applyAmbientSchedule([working], Date.now())[0].ambientSeat).toBeUndefined()
  })

  test("待命员工的生活动作映射为独立动画", () => {
    expect(resolveCharacterMotion(activity({ ambientAction: "strolling" }))).toBe("walk")
    expect(resolveCharacterMotion(activity({ ambientAction: "chatting" }))).toBe("talk")
    expect(resolveCharacterMotion(activity({ ambientAction: "reading" }))).toBe("read")
  })

  test("内置员工稳定分配到多种人物形象并允许手动切换", () => {
    const agentIds = ["general", "researcher", "requirements-analyst", "hardware-engineer", "test-engineer", "architect", "os-engineer"]
    expect(new Set(agentIds.map((id) => officeCharacterProfile(id).id)).size).toBeGreaterThanOrEqual(6)
    expect(officeCharacterProfile("general")).toEqual(officeCharacterProfile("general"))
    expect(officeCharacterProfile("general", "momo").id).toBe("momo")
    expect(officeCharacterProfile("general", "missing").id).toBe("taotao")
  })

  test("每个内置人物都有独立的背向坐姿素材", () => {
    for (const profile of ["taotao", "xingya", "momo", "xinzai", "caiya", "hetang", "oumu"]) {
      expect(existsSync(join(APP_ROOT, "public", "office", "characters", "v3", "seated-back", `${profile}.png`))).toBe(true)
    }
  })

  test("家具不能越界或重叠，并能自动找到空位", () => {
    const placed: OfficeFurniturePlacement[] = [{ instanceId: "plant-1", itemId: "mint-plant", x: 46, y: 72, rotation: 0 }]
    expect(canPlaceFurniture({ x: 48, y: 73 }, placed, "amber-lamp")).toBe(false)
    expect(canPlaceFurniture({ x: 2, y: 50 }, placed, "amber-lamp")).toBe(false)
    expect(findFurnitureSpace(placed, "amber-lamp")).toEqual({ x: 61, y: 59 })
  })

  test("电脑任务回到专属工位，硬件与打印任务才临时离开", () => {
    const anchors = officeThemePack("aurora-lab").anchors
    const compiling = activity({ agentId: "firmware-engineer", state: "executing", toolName: "compile" })
    const flashing = activity({ agentId: "firmware-engineer", state: "executing", toolName: "flash" })
    const printing = activity({ agentId: "doc-writer", state: "executing", toolName: "write_office" })
    expect(isWorkstationActivity(compiling)).toBe(true)
    expect(agentPosition(compiling, 0, anchors).zone).toContain("固件")
    expect(agentPosition(flashing, 0, anchors).x).toBe(anchors["lab-access"].x)
    expect(agentPosition(printing, 0, anchors).x).toBe(anchors["printer-access"].x)
  })

  test("每个工作角色只占用场景中真实存在的一把工位椅", () => {
    const agents = ["software-engineer", "ui-engineer", "ui-dev", "os-engineer"].map((agentId, index) =>
      activity({ runId: `work-${index}`, agentId, state: "editing", toolName: "edit" }))
    const seats = Object.values(assignOfficeSeats(agents, officeThemePack("classic").anchors))
    expect(seats).toHaveLength(3)
    expect(new Set(seats.map((seat) => seat.seatId)).size).toBe(3)
    expect(seats.every((seat) => seat.y > officeThemePack("classic").anchors[seat.stationId].y)).toBe(true)
  })

  test("真实任务优先于待命玩电脑员工获得专属工位", () => {
    const anchors = officeThemePack("classic").anchors
    const idleWorkers = ["general", "software-engineer", "firmware-engineer"].map((agentId, index) =>
      activity({ runId: `idle-${index}`, agentId, state: "standby", ambientAction: "computer" }))
    const activeWorker = activity({
      runId: "real-task",
      agentId: "firmware-engineer",
      state: "executing",
      toolName: "compile",
    })
    const assignments = assignOfficeSeats([...idleWorkers, activeWorker], anchors)
    expect(assignments["real-task"]).toMatchObject({
      stationId: "desk-firmware",
      kind: "workstation",
    })
    expect(Object.values(assignments)).toHaveLength(3)
  })

  test("每个主题的工位座椅都位于桌体碰撞区外", () => {
    for (const packId of ["classic", "aurora-lab"]) {
      const pack = officeThemePack(packId)
      const obstacles = [
        ...resolveOfficeObstacles(pack.obstacles, pack.anchors),
        ...resolveSceneObjectObstacles(pack.sceneObjects ?? [], pack.anchors),
      ]
      for (const stationId of ["desk-project", "desk-software", "desk-firmware"]) {
        const seat = officeSeatPoint(stationId, pack.anchors)
        const desk = obstacles.find((obstacle) => obstacle.id === stationId || obstacle.id === `scene:${stationId}`)!
        expect(seat.y).toBeGreaterThanOrEqual(desk.y + desk.height)
      }
    }
    expect(officeSeatPoint("desk-project", officeThemePack("classic").anchors)).toEqual({ x: 12, y: 41 })
  })

  test("布局编辑移动工位时对应座椅保持相同相对位置", () => {
    const pack = officeThemePack("classic")
    const scene = resolveOfficeScenePositions(pack, { "desk-project": { x: 30, y: 40 } })
    expect(scene["seat-project"]).toEqual({ x: 30, y: 47 })
    expect(officeSeatPoint("desk-project", scene)).toEqual({ x: 30, y: 47 })
    const movedLab = resolveOfficeScenePositions(pack, { lab: { x: 80, y: 45 } })
    expect(movedLab["lab-seat"]).toEqual({ x: 80, y: 52 })
    expect(movedLab["lab-access"]).toEqual({ x: 67.5, y: 50 })
  })

  test("焊接台圆凳是唯一物理座位且只分配给硬件操作", () => {
    const anchors = officeThemePack("classic").anchors
    const workers = [
      activity({ runId: "flash-1", state: "executing", toolName: "flash" }),
      activity({ runId: "flash-2", state: "executing", toolName: "swd_debug" }),
      activity({ runId: "edit-1", state: "editing", toolName: "edit" }),
    ]
    const seats = Object.values(assignOfficeLabSeat(workers, anchors))
    expect(seats).toHaveLength(1)
    expect(seats[0]).toMatchObject({ runId: "flash-1", seatId: "lab:stool", kind: "lab-stool", x: 82, y: 58 })
  })

  test("坐稳后椅背始终遮挡人物躯干且不受选中状态破坏", () => {
    const y = 30
    expect(officeChairZIndex(y, true)).toBeGreaterThan(officeAvatarZIndex(y, false, true))
    expect(officeChairZIndex(y, true)).toBeGreaterThan(officeAvatarZIndex(y, true, true))
    expect(officeAvatarZIndex(y, true, false)).toBeGreaterThan(officeChairZIndex(y, false))
  })

  test("员工起身、行走和入座时椅子始终固定在物理锚点", () => {
    for (const phase of ["walking", "rising", "aligning", "turning", "sitting", "seated", "standing"]) {
      expect(officeChairPose(phase)).toBe("parked")
    }
  })

  test("家具只遮挡后方员工，前方员工不会被桌面或沙发吞入", () => {
    const furnitureY = 77
    const foreground = officeSceneFrontZIndex(furnitureY)
    expect(officeAvatarZIndex(furnitureY - 5, false, false)).toBeLessThan(foreground)
    expect(officeAvatarZIndex(furnitureY + 3, false, false)).toBeGreaterThan(foreground)
  })

  test("规划任务站到当前主题的白板前并为多人错开站位", () => {
    const classic = officeThemePack("classic").anchors
    const aurora = officeThemePack("aurora-lab").anchors
    const thinking = activity({ agentId: "requirements-analyst", state: "thinking", activity: "站在白板前梳理任务方案" })
    const first = agentPosition(thinking, 0, classic)
    const second = agentPosition({ ...thinking, agentId: "architect" }, 1, classic)
    expect(first.zone).toBe("白板规划区")
    expect(classic.whiteboard.x).toBeGreaterThanOrEqual(75)
    expect(classic.whiteboard.y).toBeLessThanOrEqual(24)
    expect(classic["whiteboard-access"].y).toBeGreaterThanOrEqual(45)
    expect(first).not.toEqual(second)
    expect(Math.abs(first.x - classic["whiteboard-access"].x)).toBeLessThanOrEqual(5)
    expect(Math.abs(agentPosition(thinking, 0, aurora).x - aurora["whiteboard-access"].x)).toBeLessThanOrEqual(5)
  })

  test("商店免费领取只授予声明的本地权益", () => {
    const empty: OfficeEntitlements = { plan: "free", ownedPackIds: [], ownedFurnitureIds: [], ownedOutfitIds: [], ownedLayoutIds: [], claimedProductIds: [] }
    const classic = OFFICE_STORE_PRODUCTS.find((product) => product.id === "classic-starter")!
    const next = grantFreeOfficeProduct(empty, classic)
    expect(next.ownedPackIds).toEqual(["classic"])
    expect(next.claimedProductIds).toEqual(["classic-starter"])
    expect(ownsOfficeProduct(next, classic)).toBe(true)
  })

  test("付费商品在购买渠道接入前不能通过免费接口解锁", () => {
    const empty: OfficeEntitlements = { plan: "free", ownedPackIds: [], ownedFurnitureIds: [], ownedOutfitIds: [], ownedLayoutIds: [], claimedProductIds: [] }
    const aurora = OFFICE_STORE_PRODUCTS.find((product) => product.id === "aurora-lab-theme")!
    expect(grantFreeOfficeProduct(empty, aurora)).toBe(empty)
    expect(ownsOfficeProduct(empty, aurora)).toBe(false)
  })
})
