import { FACE, walkingFaceAt } from './faces.js'

const WALK_BLINK = {
  [FACE.strollOpen]: FACE.strollBlink,
  [FACE.strollLookLeft]: FACE.strollBlinkLeft,
  [FACE.strollLookRight]: FACE.strollBlinkRight,
}

/** Locomotion gets a quiet smile/whistle; settled agents display their thread status. */
export function animateFace(agent, dt, anim = 1) {
  agent.faceTimer += dt
  agent.blinkAt -= dt

  if (agent.state === 'spawning' && agent.stateAge < 0.8) {
    agent.faceFrame = FACE.boot
    return
  }
  if (agent.state === 'leaving') {
    agent.faceFrame = agent.stateAge % 2 < 1.4 ? FACE.happy : FACE.wink
    return
  }

  // Match actual walking, including idle wandering, but not work rounds or a blocked
  // thread. A brief speed dip at a waypoint must not flicker between two different moods.
  const travelling = (agent.state === 'spawning' || agent.state === 'walking' ||
    (agent.state === 'at-site' && agent.status === 'idle')) &&
    agent.status !== 'blocked' && agent.status !== 'broken'
  if (!travelling) agent.walkFaceHold = 0
  else if (agent.groundSpeed > 0.12 || agent.state === 'spawning') agent.walkFaceHold = 0.3
  else agent.walkFaceHold = Math.max(0, agent.walkFaceHold - dt)
  const strolling = agent.walkFaceHold > 0
  let walkFace
  if (strolling) {
    agent.walkFaceTime += dt * anim
    walkFace = walkingFaceAt(agent.walkFaceTime, agent.walkPersonality)
  }

  // Closed happy eyes do not blink open or move the whistling mouth. The open-eyed
  // walking variant has its own blink with the very same smile placement.
  if (agent.blinkAt <= 0 && (agent.status !== 'sleeping' || strolling) &&
    agent.status !== 'blocked' && agent.status !== 'broken') {
    agent.faceFrame = strolling ? (WALK_BLINK[walkFace] ?? walkFace) : FACE.blink
    if (agent.blinkAt < -0.12) agent.blinkAt = 2.4 + Math.random() * 5
    return
  }
  if (strolling) {
    agent.faceFrame = walkFace
    return
  }

  const loop = agent.loop
  if (!loop || !loop.length) {
    agent.faceFrame = FACE.idle
    return
  }
  const rate = agent.status === 'working' ? 0.22 : 0.55
  if (agent.faceTimer > rate) {
    agent.faceTimer = 0
    agent.faceIndex = (agent.faceIndex + 1) % loop.length
  }
  agent.faceFrame = loop[agent.faceIndex]
}
