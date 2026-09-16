import * as THREE from 'three'

/** CPU roof queries mirror the reveal shader's vertical sink. Broad-phase bounds keep
 * raycasts local to the handful of buildings under airborne parcels. */
export class BuildingSurfaces {
  constructor(buildings, groundAt) {
    this.buildings = buildings
    this.groundAt = groundAt
    this.ray = new THREE.Raycaster()
    this.normal = new THREE.Vector3()
    this.normalMatrix = new THREE.Matrix3()
    this.hits = []
  }

  at(x, z) {
    const result = { height: this.groundAt(x, z), nx: 0, ny: 1, nz: 0 }
    for (const { mesh } of this.buildings.values()) {
      const box = mesh.geometry.boundingBox
      if (!box) continue
      const radius = Math.hypot(Math.max(Math.abs(box.min.x), Math.abs(box.max.x)), Math.max(Math.abs(box.min.z), Math.abs(box.max.z)))
      if (Math.hypot(x - mesh.position.x, z - mesh.position.z) > radius + 0.2) continue
      const progress = mesh.userData.uniforms?.uProgress.value ?? 1
      const sink = (1 - progress) * (box.max.y - box.min.y)
      mesh.updateWorldMatrix(true, false)
      this.ray.ray.origin.set(x, mesh.position.y + box.max.y + 1, z)
      this.ray.ray.direction.set(0, -1, 0)
      this.hits.length = 0
      this.ray.intersectObject(mesh, false, this.hits)
      this.normalMatrix.getNormalMatrix(mesh.matrixWorld)
      for (const hit of this.hits) {
        // Rotor blades animate in the shader and cannot support a delivery.
        if (mesh.geometry.getAttribute('aSpin')?.getX(hit.face.a) > 0) continue
        const height = hit.point.y - sink
        if (height <= result.height) continue
        this.normal.copy(hit.face.normal).applyNormalMatrix(this.normalMatrix)
        if (this.normal.y < 0.1) continue
        result.height = height
        result.nx = this.normal.x
        result.ny = this.normal.y
        result.nz = this.normal.z
      }
    }
    return result
  }
}
