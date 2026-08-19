import { officeThemePack } from "./office-packs"

const STORAGE_KEY = "eval_office_entitlements_v2"
const LEGACY_STORAGE_KEY = "eval_office_entitlements_v1"

export interface OfficeEntitlements {
  plan: "free" | "plus"
  ownedPackIds: string[]
  ownedFurnitureIds: string[]
  ownedOutfitIds: string[]
  ownedLayoutIds: string[]
  claimedProductIds: string[]
}

const DEFAULT_ENTITLEMENTS: OfficeEntitlements = {
  plan: "free",
  ownedPackIds: ["classic"],
  ownedFurnitureIds: ["mint-plant", "amber-lamp", "blue-beanbag"],
  ownedOutfitIds: ["casual", "formal", "lab", "hoodie"],
  ownedLayoutIds: ["classic-default"],
  claimedProductIds: ["classic-starter"],
}

export function loadOfficeEntitlements(): OfficeEntitlements {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY) ?? "{}") as Partial<OfficeEntitlements>
    const owned = Array.isArray(value.ownedPackIds) ? value.ownedPackIds.filter((id): id is string => typeof id === "string") : []
    return {
      plan: value.plan === "plus" ? "plus" : "free",
      ownedPackIds: unique(["classic", ...owned]),
      ownedFurnitureIds: unique([...DEFAULT_ENTITLEMENTS.ownedFurnitureIds, ...strings(value.ownedFurnitureIds)]),
      ownedOutfitIds: unique([...DEFAULT_ENTITLEMENTS.ownedOutfitIds, ...strings(value.ownedOutfitIds)]),
      ownedLayoutIds: unique([...DEFAULT_ENTITLEMENTS.ownedLayoutIds, ...strings(value.ownedLayoutIds)]),
      claimedProductIds: unique([...DEFAULT_ENTITLEMENTS.claimedProductIds, ...strings(value.claimedProductIds)]),
    }
  } catch {
    return { ...DEFAULT_ENTITLEMENTS }
  }
}

export function saveOfficeEntitlements(entitlements: OfficeEntitlements): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entitlements))
  window.dispatchEvent(new CustomEvent("eval-office-entitlements-changed"))
}

export function ownsOfficePack(entitlements: OfficeEntitlements, packId: string): boolean {
  const pack = officeThemePack(packId)
  return pack.tier === "free" || entitlements.plan === "plus" || entitlements.ownedPackIds.includes(pack.id)
}

export function ownedOfficeFurnitureIds(entitlements: OfficeEntitlements): string[] {
  const packFurniture = entitlements.ownedPackIds.flatMap((id) => officeThemePack(id).includedFurnitureIds)
  return unique([...entitlements.ownedFurnitureIds, ...packFurniture])
}

export function subscribeOfficeEntitlements(listener: () => void): () => void {
  window.addEventListener("eval-office-entitlements-changed", listener)
  return () => window.removeEventListener("eval-office-entitlements-changed", listener)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}
