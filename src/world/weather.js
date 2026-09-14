import * as THREE from 'three'

/**
 * Git & Colony Weather System
 *
 * Translates the collective health and activity of all agent threads into dynamic
 * ambient atmosphere, fog, and particle phenomena:
 *
 * 1. Storm (Blocked / Error):
 *    - Triggered when one or more threads have errors / blocked tasks.
 *    - Atmosphere takes on a moody, intense horizon tint.
 *    - Fog draws in and cosmic static / embers drift through the colony.
 *
 * 2. Aurora (Celebrating / Shipped):
 *    - Triggered when Pull Requests are merged or work is shipped.
 *    - Shimmering stardust and auroral glow wash across the upper sky.
 *
 * 3. Calm (Default):
 *    - Peaceful planet conditions with normal ambient lighting.
 *
 * Transitions are smoothly dampened over 2.5 seconds to prevent jarring cuts.
 */

export class WeatherSystem {
  constructor(settings) {
    this.settings = settings
    this.stormIntensity = 0
    this.auroraIntensity = 0
    this.targetStorm = 0
    this.targetAurora = 0
    this.weatherType = 'calm'
  }

  /**
   * Re-evaluate aggregate thread statuses
   * @param {Array<Object>} threads
   */
  updateStatus(threads) {
    if (!threads || !threads.length) {
      this.targetStorm = 0
      this.targetAurora = 0
      this.weatherType = 'calm'
      return
    }

    const enabled = this.settings.get('gitWeather') ?? true
    if (!enabled) {
      this.targetStorm = 0
      this.targetAurora = 0
      this.weatherType = 'calm'
      return
    }

    let blockedCount = 0
    let mergedCount = 0

    for (const t of threads) {
      if (t.hasError) blockedCount++
      const pr = String(t.prState || '').toLowerCase()
      if (pr === 'merged') mergedCount++
    }

    if (blockedCount > 0) {
      this.targetStorm = Math.min(1, 0.4 + blockedCount * 0.3)
      this.targetAurora = 0
      this.weatherType = 'storm'
    } else if (mergedCount > 0) {
      this.targetStorm = 0
      this.targetAurora = Math.min(1, 0.5 + mergedCount * 0.25)
      this.weatherType = 'aurora'
    } else {
      this.targetStorm = 0
      this.targetAurora = 0
      this.weatherType = 'calm'
    }
  }

  tick(dt) {
    // Smooth transition damping
    this.stormIntensity = THREE.MathUtils.damp(this.stormIntensity, this.targetStorm, 1.8, dt)
    this.auroraIntensity = THREE.MathUtils.damp(this.auroraIntensity, this.targetAurora, 1.8, dt)
  }

  get state() {
    return {
      type: this.weatherType,
      storm: this.stormIntensity,
      aurora: this.auroraIntensity,
    }
  }
}
