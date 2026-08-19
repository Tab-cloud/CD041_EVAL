import type { OfficeObstacle } from "../office/office-navigation"

/** Repaints furniture foregrounds above characters that are physically behind them. */
export function OfficeOcclusionLayer({ obstacles }: { obstacles: OfficeObstacle[] }) {
  return <div className="office-occlusion-layer" aria-hidden="true">
    {obstacles.map((obstacle) => <span
      key={obstacle.id}
      className="office-occluder"
      style={{
        clipPath: `inset(${obstacle.y}% ${Math.max(0, 100 - obstacle.x - obstacle.width)}% ${Math.max(0, 100 - obstacle.y - obstacle.height)}% ${obstacle.x}%)`,
        zIndex: Math.round(obstacle.y + obstacle.height) + 18,
      }}
    />)}
  </div>
}
