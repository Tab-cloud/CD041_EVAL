/** Depth rules for physical seating. The chair back must occlude a seated torso. */
export function officeAvatarZIndex(y: number, selected: boolean, physicallySeated: boolean): number {
  if (selected && !physicallySeated) return 120
  return Math.round(y) + (physicallySeated ? 32 : 20)
}

export function officeChairZIndex(y: number, seated: boolean): number {
  return Math.round(y) + (seated ? 35 : 26)
}

/**
 * A furniture foreground sits between employees whose feet are behind and
 * employees whose feet are in front. This prevents the foreground mask from
 * swallowing a person who is correctly standing on the near side.
 */
export function officeSceneFrontZIndex(y: number): number {
  return Math.round(y) + 18
}

/** Chairs are physical anchors. Character transitions must never move them. */
export function officeChairPose(_phase?: string): "parked" {
  return "parked"
}
