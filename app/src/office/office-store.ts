import type { OfficeEntitlements } from "./office-entitlements"

export type OfficeProductCategory = "theme" | "furniture" | "appearance" | "renovation" | "seasonal"
export type OfficeProductAvailability = "free" | "coming-soon" | "channel-pending"

export interface OfficeStoreProduct {
  id: string
  sku: string
  category: OfficeProductCategory
  name: string
  subtitle: string
  description: string
  price: number
  currency: "CNY"
  availability: OfficeProductAvailability
  badge?: string
  accent: string
  previewImage?: string
  previewPackId?: string
  includes: string[]
  grants: {
    packIds?: string[]
    furnitureIds?: string[]
    outfitIds?: string[]
    layoutIds?: string[]
  }
}

export const OFFICE_PRODUCT_CATEGORIES: Array<{ id: "all" | "owned" | OfficeProductCategory; label: string }> = [
  { id: "all", label: "精选" }, { id: "theme", label: "办公室主题" }, { id: "furniture", label: "家具与摆件" },
  { id: "appearance", label: "人物外观" }, { id: "renovation", label: "装修服务" }, { id: "seasonal", label: "节日限定" },
  { id: "owned", label: "我的资产" },
]

export const OFFICE_STORE_PRODUCTS: OfficeStoreProduct[] = [
  {
    id: "classic-starter", sku: "EVAL-OFFICE-CLASSIC-001", category: "theme", name: "星港工作室",
    subtitle: "每位开发者的第一间办公室", description: "经典嵌入式研发空间，包含三组工位、实验桌、休息区和基础家具。",
    price: 0, currency: "CNY", availability: "free", badge: "永久免费", accent: "#5eead4",
    previewImage: "/office/digital-office-dark.png", previewPackId: "classic",
    includes: ["Light / Dark 双场景", "薄荷盆栽", "琥珀落地灯", "云朵懒人椅"],
    grants: { packIds: ["classic"], furnitureIds: ["mint-plant", "amber-lamp", "blue-beanbag"], layoutIds: ["classic-default"] },
  },
  {
    id: "aurora-lab-theme", sku: "EVAL-OFFICE-AURORA-001", category: "theme", name: "极光电路实验室",
    subtitle: "把每次编译变成一场极光实验", description: "商业级极光科研主题，含独立工作区锚点、限定灯光与四件实验室家具。",
    price: 28, currency: "CNY", availability: "channel-pending", badge: "Plus 精选", accent: "#a78bfa",
    previewImage: "/office/aurora-lab-dark.png", previewPackId: "aurora-lab",
    includes: ["Light / Dark 双场景", "极光蕨", "星轨灯", "迷你算力塔", "电路奖杯"],
    grants: { packIds: ["aurora-lab"], furnitureIds: ["violet-plant", "aurora-lamp", "mini-server", "circuit-trophy"] },
  },
  {
    id: "cozy-lounge-bundle", sku: "EVAL-FURNITURE-COZY-001", category: "furniture", name: "快乐摸鱼角",
    subtitle: "认真工作，也要认真休息", description: "为沙发聊天、喝茶和项目复盘准备的温暖休息区家具套装。",
    price: 12, currency: "CNY", availability: "channel-pending", badge: "家具套装", accent: "#fb7185",
    includes: ["落日双人沙发", "猫咪抱枕", "暖光茶几"],
    grants: { furnitureIds: ["sunset-sofa", "cat-cushion", "tea-table"] },
  },
  {
    id: "inventor-decor-bundle", sku: "EVAL-FURNITURE-LAB-002", category: "furniture", name: "发明家收藏室",
    subtitle: "让每个角落都有实验故事", description: "适合资料室和硬件实验区的动态装饰组合。",
    price: 16, currency: "CNY", availability: "channel-pending", badge: "动态摆件", accent: "#22d3ee",
    includes: ["像素水族箱", "蓝图地毯", "电路奖杯展示台"],
    grants: { furnitureIds: ["pixel-aquarium", "blueprint-rug", "circuit-trophy"] },
  },
  {
    id: "night-flight-outfit", sku: "EVAL-OUTFIT-NIGHT-001", category: "appearance", name: "夜航开发者",
    subtitle: "深夜提交也要保持可爱", description: "夜航配色连帽衫、角色名牌光效和专属待机动作组合。",
    price: 8, currency: "CNY", availability: "coming-soon", badge: "角色外观", accent: "#818cf8",
    includes: ["夜航连帽衫", "霓虹名牌", "专属待机动作"], grants: { outfitIds: ["night-flight"] },
  },
  {
    id: "startup-renovation", sku: "EVAL-SERVICE-ROOM-001", category: "renovation", name: "研发总部装修方案",
    subtitle: "由官方设计师替你的 Agent 团队布置", description: "根据团队规模和工作类型提供分区设计、一键布局与家具清单。",
    price: 199, currency: "CNY", availability: "channel-pending", badge: "布置服务", accent: "#f59e0b",
    includes: ["空间需求问卷", "一套定制布局", "两轮本地调整", "家具购买清单"], grants: { layoutIds: ["custom-renovation-slot"] },
  },
  {
    id: "lunar-festival-pack", sku: "EVAL-SEASON-LUNAR-001", category: "seasonal", name: "新春开工大吉",
    subtitle: "限定窗景、灯笼和交付庆祝动作", description: "为春节版本冲刺准备的季节主题装饰包。",
    price: 18, currency: "CNY", availability: "coming-soon", badge: "节日限定", accent: "#ef4444",
    includes: ["新春灯光主题", "窗花与灯笼", "开工庆祝动作", "限定打印机纸张"], grants: { layoutIds: ["lunar-festival"] },
  },
]

export function ownsOfficeProduct(entitlements: OfficeEntitlements, product: OfficeStoreProduct): boolean {
  if (entitlements.claimedProductIds.includes(product.id)) return true
  const grants = product.grants
  const ids = [...(grants.packIds ?? []), ...(grants.furnitureIds ?? []), ...(grants.outfitIds ?? []), ...(grants.layoutIds ?? [])]
  const owned = new Set([...entitlements.ownedPackIds, ...entitlements.ownedFurnitureIds, ...entitlements.ownedOutfitIds, ...entitlements.ownedLayoutIds])
  return ids.length > 0 && ids.every((id) => owned.has(id))
}

export function grantFreeOfficeProduct(entitlements: OfficeEntitlements, product: OfficeStoreProduct): OfficeEntitlements {
  if (product.availability !== "free" || product.price !== 0) return entitlements
  return {
    ...entitlements,
    ownedPackIds: unique([...entitlements.ownedPackIds, ...(product.grants.packIds ?? [])]),
    ownedFurnitureIds: unique([...entitlements.ownedFurnitureIds, ...(product.grants.furnitureIds ?? [])]),
    ownedOutfitIds: unique([...entitlements.ownedOutfitIds, ...(product.grants.outfitIds ?? [])]),
    ownedLayoutIds: unique([...entitlements.ownedLayoutIds, ...(product.grants.layoutIds ?? [])]),
    claimedProductIds: unique([...entitlements.claimedProductIds, product.id]),
  }
}

const WISHLIST_KEY = "eval_office_store_wishlist_v1"

export function loadOfficeWishlist(): string[] {
  try { return JSON.parse(localStorage.getItem(WISHLIST_KEY) ?? "[]").filter((id: unknown) => typeof id === "string") }
  catch { return [] }
}

export function saveOfficeWishlist(ids: string[]): void {
  localStorage.setItem(WISHLIST_KEY, JSON.stringify(unique(ids)))
}

export function setOfficeStorePreviewPack(packId: string): void {
  sessionStorage.setItem("eval_office_store_preview_pack", packId)
}

export function loadOfficeStorePreviewPack(): string | null {
  return sessionStorage.getItem("eval_office_store_preview_pack")
}

export function clearOfficeStorePreviewPack(): void {
  sessionStorage.removeItem("eval_office_store_preview_pack")
}

function unique(values: string[]): string[] { return Array.from(new Set(values)) }
