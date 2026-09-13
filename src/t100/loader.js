import { normalizeEvents, normalizeLayout, normalizeReadiness } from './contracts.js'

async function json(path) {
  const response = await fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(`T100 request failed (${response.status}) for ${path}`)
  return response.json()
}

/**
 * Load everything the T100 view runs on: the aggregate world read model, the raw
 * floorplan (normalized to client shapes), the runtime readiness overlay, and the
 * two illustrative replay streams.
 *
 * The world is the source of truth for capability facts (units, facets, rungs,
 * gates, placement, attention, provenance). The layout supplies the shared
 * geometry both layers draw on. They are fetched together but stay distinct.
 */
export async function loadT100() {
  const [world, layout, readiness, syntheticEvents, goldenEvents] = await Promise.all([
    json('/api/t100/world'),
    json('/api/t100/layout'),
    json('/api/t100/readiness').catch(() => ({})),
    json('/api/t100/events?stream=synthetic').catch(() => ({ events: [] })),
    json('/api/t100/events?stream=golden').catch(() => ({ events: [] })),
  ])
  return {
    world,
    layout: normalizeLayout(layout),
    readiness: normalizeReadiness(readiness),
    replays: {
      synthetic: normalizeEvents(syntheticEvents.events || syntheticEvents),
      golden: normalizeEvents(goldenEvents.events || goldenEvents),
    },
  }
}
