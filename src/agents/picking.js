import { bendPoint } from '../core/curve.js'

/** Project a world-space body landmark into aspect-corrected screen coordinates. */
export function projectHitPoint(point, radius, camera, aspect, out) {
  bendPoint(point).applyMatrix4(camera.matrixWorldInverse)
  const depth = -point.z
  out.visible = depth >= camera.near && depth <= camera.far
  out.depth = depth
  // Perspective-correct radius, with the sphere's nearest surface used at close zoom.
  out.radius = camera.projectionMatrix.elements[5] * radius / Math.max(camera.near, depth - radius)
  point.applyMatrix4(camera.projectionMatrix)
  out.x = point.x * aspect
  out.y = point.y
  out.z = point.z
  return out
}

/** Distance from the cursor to a tapered capsule joining two projected body landmarks.
 * Zero anywhere inside the body; positive distances allow a small forgiving click margin. */
export function bodyHitDistance(x, y, a, b = a) {
  if (!a.visible || !b.visible) return Infinity
  const dx = b.x - a.x, dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  const t = length2 > 1e-10 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0
  const radius = a.radius + (b.radius - a.radius) * t
  return Math.max(0, Math.hypot(x - a.x - dx * t, y - a.y - dy * t) - radius)
}
