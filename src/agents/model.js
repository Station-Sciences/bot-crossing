import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

// All dimensions are relative to the existing rig's helmet radius. These accessories
// remain merged and instanced: rounder silhouettes do not add per-agent draw calls.
export const VISOR_OPENING = Math.asin(0.76)
export const SCREEN_RADIUS = 0.69
export const SCREEN_DEPTH = 0.46
export const SCREEN_BULGE = 0.09

function colored(geo, hex) {
  const c = new THREE.Color(hex), colors = new Float32Array(geo.attributes.position.count * 3)
  for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i)
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geo
}

function merge(parts) {
  // Flatten for merging, then weld identical attributes back into shared vertices.
  const flat = parts.map(g => g.index ? g.toNonIndexed() : g)
  const combined = mergeGeometries(flat, false)
  combined.deleteAttribute('uv')
  const merged = mergeVertices(combined, 1e-5)
  combined.dispose()
  for (const g of new Set([...parts, ...flat])) g.dispose()
  return merged
}

export function helmetGeometry(R) {
  const shell = new THREE.SphereGeometry(R, 32, 18, 0, Math.PI * 2, VISOR_OPENING, Math.PI - VISOR_OPENING)
  shell.rotateX(Math.PI / 2)
  const parts = [colored(shell, 0xffffff)]
  const front = Math.cos(VISOR_OPENING) * R, back = SCREEN_DEPTH * R
  const wall = new THREE.CylinderGeometry(R * 0.76, R * SCREEN_RADIUS, front - back, 32, 1, true)
  wall.rotateX(Math.PI / 2); wall.translate(0, 0, (front + back) / 2)
  // The cavity is viewed from inside its wall, not from outside a cylinder.
  const ix = wall.index.array, normals = wall.attributes.normal
  for (let i = 0; i < ix.length; i += 3) [ix[i], ix[i + 1]] = [ix[i + 1], ix[i]]
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, -normals.getX(i), -normals.getY(i), -normals.getZ(i))
  parts.push(colored(wall, 0x182033))
  const seal = new THREE.TorusGeometry(R * 0.76, R * 0.012, 4, 40)
  seal.translate(0, 0, front)
  parts.push(colored(seal, 0x69768b))
  // One flat-faced cylinder per ear. Only the very edge is softly rounded;
  // there is no separate socket, inset cap, or broad chamfer.
  const earRadius = R * 0.21, earHalfDepth = R * 0.055, edgeRadius = R * 0.009
  const earProfile = [new THREE.Vector2(0, -earHalfDepth)]
  for (let i = 0; i <= 4; i++) {
    const angle = i / 4 * Math.PI / 2
    earProfile.push(new THREE.Vector2(earRadius - edgeRadius + edgeRadius * Math.sin(angle),
      -earHalfDepth + edgeRadius * (1 - Math.cos(angle))))
  }
  for (let i = 0; i <= 4; i++) {
    const angle = i / 4 * Math.PI / 2
    earProfile.push(new THREE.Vector2(earRadius - edgeRadius + edgeRadius * Math.cos(angle),
      earHalfDepth - edgeRadius + edgeRadius * Math.sin(angle)))
  }
  earProfile.push(new THREE.Vector2(0, earHalfDepth))
  for (const side of [-1, 1]) {
    const ear = new THREE.LatheGeometry(earProfile, 32)
    ear.rotateZ(-side * Math.PI / 2); ear.translate(side * R, 0, -R * 0.06)
    parts.push(colored(ear, 0xf4f5f7))
  }
  return merge(parts)
}

export function visorGeometry(R) {
  const cap = new THREE.SphereGeometry(R * 1.012, 32, 10, 0, Math.PI * 2, 0, VISOR_OPENING)
  cap.rotateX(Math.PI / 2)
  // A rolled glass edge supplies a little actual thickness and a grazing reflection.
  // Merge into the existing visor draw; no second transparent pane or scene pass.
  const edge = new THREE.TorusGeometry(R * 0.742, R * 0.016, 8, 48)
  edge.translate(0, 0, R * 0.694)
  const geometry = mergeGeometries([cap, edge], false)
  cap.dispose(); edge.dispose()
  return geometry
}

export function screenGeometry(R) {
  // Concentric rings give the display a shallow convex surface, with UVs projected
  // onto its face. The rim still meets the cavity exactly; only the centre bulges.
  const segments = 48, rings = 8, positions = [], uvs = [], indices = []
  for (let ring = 0; ring <= rings; ring++) {
    const radius = ring / rings
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2
      const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius
      positions.push(x * R * SCREEN_RADIUS, y * R * SCREEN_RADIUS,
        R * (SCREEN_DEPTH + SCREEN_BULGE * (1 - radius * radius)))
      uvs.push(x * 0.5 + 0.5, y * 0.5 + 0.5)
      if (ring < rings && i < segments) {
        const a = ring * (segments + 1) + i, b = a + segments + 1
        if (ring > 0) indices.push(a, b, a + 1)
        indices.push(b, b + 1, a + 1)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
