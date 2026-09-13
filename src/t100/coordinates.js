export function createCoordinateMap(chipSizeUm, worldWidth = 48) {
  const width = Math.max(1, Number(chipSizeUm.width) || 1)
  const height = Math.max(1, Number(chipSizeUm.height) || 1)
  const scale = worldWidth / Math.max(width, height)
  return {
    scale,
    worldWidth: width * scale,
    worldHeight: height * scale,
    point(xUm, yUm) {
      return {
        x: (Number(xUm) - width / 2) * scale,
        z: (Number(yUm) - height / 2) * scale,
      }
    },
    rect(rectUm) {
      const center = this.point(rectUm.x + rectUm.width / 2, rectUm.y + rectUm.height / 2)
      return {
        ...center,
        width: rectUm.width * scale,
        depth: rectUm.height * scale,
      }
    },
  }
}
