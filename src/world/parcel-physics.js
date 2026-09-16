/** Vertical clearance for a rotating 0.3 m cube on the queried tangent plane. */
function clearance(p, { nx = 0, ny = 1, nz = 0 }) {
  const cx = Math.cos(p.tilt), sx = Math.sin(p.tilt)
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw)
  return 0.15 * (Math.abs(nx * cy + ny * sx * sy - nz * cx * sy) +
    Math.abs(ny * cx + nz * sx) + Math.abs(nx * sy - ny * sx * cy + nz * cx * cy)) / Math.max(0.1, ny)
}

/** Integrate a small parcel against a height/normal query, in bounded physics steps. */
export function stepParcel(p, dt, surfaceAt) {
  const half = 0.15
  let impact = false
  const steps = Math.max(1, Math.ceil(dt / (1 / 60)))
  const h = dt / steps
  for (let i = 0; i < steps; i++) {
    const support = surfaceAt(p.x, p.z)
    if (p.bounces >= 3 && p.vx === 0 && p.vy === 0 && p.vz === 0) {
      // A roof can still rise during construction, or disappear as a thread retires.
      if (Math.abs(p.y - clearance(p, support) - support.height) < 0.25) {
        p.y = support.height + clearance(p, support)
        continue
      }
      p.bounces = 0
    }
    const oldX = p.x, oldZ = p.z
    p.vy -= 9.8 * h
    p.x += p.vx * h
    p.y += p.vy * h
    p.z += p.vz * h
    p.yaw += p.spin * h
    p.tilt += p.spin * 0.6 * h
    let surface = surfaceAt(p.x, p.z)
    // A higher surface entered horizontally is a wall/ledge, not a floor to teleport up.
    if (surface.height > support.height + 0.2 && surface.height > p.y + half) {
      p.x = oldX
      p.z = oldZ
      p.vx *= -0.38
      p.vz *= -0.38
      surface = support
    }
    // Check the cube's corners, not just its centre, including on sloping roofs.
    const extent = clearance(p, surface)
    if (p.y - extent > surface.height || p.vy >= 0) continue
    p.y = surface.height + extent
    const { nx = 0, ny = 1, nz = 0 } = surface
    const vn = p.vx * nx + p.vy * ny + p.vz * nz
    p.vx = (p.vx - vn * nx) * 0.55 - vn * nx * 0.38
    p.vy = (p.vy - vn * ny) * 0.55 - vn * ny * 0.38
    p.vz = (p.vz - vn * nz) * 0.55 - vn * nz * 0.38
    p.spin *= 0.4
    p.bounces++
    if (!p.landed) impact = true
    p.landed = true
    if (ny > 0.65 && (p.bounces >= 3 || Math.hypot(p.vx, p.vy, p.vz) < 0.4)) {
      p.bounces = 3
      p.vx = p.vy = p.vz = p.spin = p.tilt = 0
      p.y = surface.height + clearance(p, surface)
    }
  }
  return impact
}
