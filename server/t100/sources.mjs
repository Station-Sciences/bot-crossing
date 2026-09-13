/**
 * The impure half of the T100 world: load, pin, and cache the sources, then hand
 * pure JSON to buildWorld.
 *
 * Everything Bot Crossing reads here is read-only. The one subprocess is the
 * Python bridge, which itself only runs the canonical scorer against a temp
 * JUnit — it never writes into the models repo. If any source is missing or the
 * bridge fails, the bundled snapshot under fixtures/ is served instead, with its
 * provenance honestly marked `fixture` so the UI can say so.
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveConfig, FIXTURE_DIR } from './config.mjs'
import { buildWorld } from './world.mjs'
import { loadTeamEvidence } from './team-evidence.mjs'

const execFileP = promisify(execFile)

const readJson = async (p) => JSON.parse(await fsp.readFile(p, 'utf8'))
const readJsonSync = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const fixture = (name) => path.join(FIXTURE_DIR, name)

async function statMtime(p) {
  try {
    return (await fsp.stat(p)).mtimeMs
  } catch {
    return 0
  }
}

async function sha256(p) {
  try {
    const buf = await fsp.readFile(p)
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/** Best-effort short git revision for whatever repo a path sits in. No network. */
async function gitRevision(filePath) {
  if (!filePath) return ''
  try {
    const { stdout } = await execFileP('git', ['-C', path.dirname(filePath), 'rev-parse', '--short', 'HEAD'], {
      timeout: 3000,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * `kind` says what `observedAt` actually measures, which decides whether age is a
 * freshness signal at all:
 *   authored — a hand-maintained SSoT file; mtime is when a human last edited the
 *              spec, so age means "stable", not "stale".
 *   computed — produced on demand (the scorer); as fresh as the run.
 *   observed — a sampled runtime feed; age genuinely means staleness.
 */
async function provenanceFor(livePath, { source, kind = 'authored' }) {
  const observedAt = await statMtime(livePath)
  return {
    path: livePath,
    source, // 'live' | 'fixture'
    kind,
    observedAt,
    revision: source === 'live' ? await gitRevision(livePath) : '',
    sha: await sha256(livePath),
  }
}

/**
 * Run the Python bridge to get { manifest, roster, ladder, status }. Falls back
 * to the bundled bridge.json snapshot on any failure.
 */
async function loadBridge(cfg) {
  const canRun = cfg.modelsRepo && fs.existsSync(cfg.bridgeScript) && fs.existsSync(cfg.python)
  if (canRun) {
    try {
      const args = [cfg.bridgeScript, '--repo', cfg.modelsRepo]
      if (cfg.fidelity) args.push('--fidelity', cfg.fidelity)
      const json = await runCapture(cfg.python, args, 30_000)
      const parsed = JSON.parse(json)
      const p = await provenanceFor(path.join(cfg.modelsRepo, 't100.yaml'), { source: 'live' })
      // The manifest is authored (mtime = last spec edit); the score is computed
      // by the run we just made, so it carries its own clock.
      return { data: parsed, provenance: { ...p, generator: 'bridge.py', computedAt: Date.now() } }
    } catch (err) {
      // fall through to fixture
      lastBridgeError = String(err && err.message ? err.message : err)
    }
  }
  const data = readJsonSync(fixture('bridge.json'))
  const p = await provenanceFor(fixture('bridge.json'), { source: 'fixture' })
  return { data, provenance: p }
}

let lastBridgeError = ''

function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`bridge timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.trim()) resolve(out)
      else reject(new Error(`bridge exited ${code}: ${err.slice(0, 400)}`))
    })
  })
}

async function loadWithFallback(livePath, fixtureName) {
  if (livePath && fs.existsSync(livePath)) {
    try {
      const data = await readJson(livePath)
      return { data, provenance: await provenanceFor(livePath, { source: 'live' }) }
    } catch {
      /* fall through */
    }
  }
  const fp = fixture(fixtureName)
  return { data: readJsonSync(fp), provenance: await provenanceFor(fp, { source: 'fixture' }) }
}

/** Optional evidence: the weekly ledger and machine-readable run records. */
async function loadEvidence(cfg) {
  const weekly = []
  if (cfg.weekly && fs.existsSync(cfg.weekly)) {
    try {
      const text = await fsp.readFile(cfg.weekly, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim()
        if (t) {
          try {
            weekly.push(JSON.parse(t))
          } catch {
            /* skip a malformed ledger line rather than fail the world */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  const artifacts = []
  if (cfg.evidenceDir && fs.existsSync(cfg.evidenceDir)) {
    try {
      for (const name of await fsp.readdir(cfg.evidenceDir)) {
        if (!name.endsWith('.json')) continue
        try {
          const doc = await readJson(path.join(cfg.evidenceDir, name))
          for (const rec of Array.isArray(doc) ? doc : [doc]) artifacts.push(rec)
        } catch {
          /* skip */
        }
      }
    } catch {
      /* ignore */
    }
  }
  const observedAt = Math.max(await statMtime(cfg.weekly), 0)
  return {
    data: { weekly, artifacts },
    provenance: { path: cfg.weekly || '', source: cfg.weekly ? 'live' : 'none', kind: 'observed', observedAt },
  }
}

// ── caching ──────────────────────────────────────────────────────────────────
let cache = null

async function inputSignature(cfg) {
  const paths = [
    cfg.modelsRepo && path.join(cfg.modelsRepo, 't100.yaml'),
    cfg.modelsRepo && path.join(cfg.modelsRepo, 'units.yaml'),
    cfg.modelsRepo && path.join(cfg.modelsRepo, 'milestones.yaml'),
    cfg.modelsRepo && path.join(cfg.modelsRepo, 'build', 'unit-tests.xml'),
    cfg.layout,
    cfg.overlay,
    cfg.weekly,
    cfg.joinFile,
  ].filter(Boolean)
  const mtimes = await Promise.all(paths.map(statMtime))
  return paths.map((p, i) => `${p}:${mtimes[i]}`).join('|')
}

/**
 * The assembled world, cached until an input file changes or the TTL lapses.
 * Rebuilding runs the Python bridge, so it is not something to do per request.
 */
export async function getWorld({ force = false, env = process.env } = {}) {
  const cfg = resolveConfig(env)
  const now = Date.now()
  if (!force && cache && now - cache.builtAt < cfg.ttlMs) return cache.world

  const signature = await inputSignature(cfg)
  if (!force && cache && cache.signature === signature) {
    cache.builtAt = now
    return cache.world
  }

  lastBridgeError = ''
  const [bridge, layout, overlay, evidence, team] = await Promise.all([
    loadBridge(cfg),
    loadWithFallback(cfg.layout, 'instances.json'),
    loadWithFallback(cfg.overlay, 'status-overlay.json'),
    loadEvidence(cfg),
    loadTeamEvidence(cfg),
  ])

  const provenance = {
    manifest: bridge.provenance,
    // Same repo revision as the manifest, but a different kind of fact: the score
    // is recomputed per request, so it is never stale for being an old file.
    scorer: { ...bridge.provenance, kind: bridge.provenance.computedAt ? 'computed' : 'authored' },
    layout: layout.provenance,
    // A runtime status feed: here age really does mean stale.
    overlay: { ...overlay.provenance, kind: 'observed' },
    evidence: evidence.provenance,
    team: team.provenance,
    bridgeError: lastBridgeError || undefined,
  }

  const world = buildWorld({
    bridge: bridge.data,
    layout: layout.data,
    overlay: overlay.data,
    evidence: evidence.data,
    teamEvidence: team,
    provenance,
    now,
    staleMs: cfg.staleMs,
  })

  cache = { world, builtAt: now, signature, rawLayout: layout.data, evidence: evidence.data, team }
  return world
}

/** The floorplan instances, straight through, for the client chip view. */
export async function getLayout({ env = process.env } = {}) {
  const cfg = resolveConfig(env)
  const { data } = await loadWithFallback(cfg.layout, 'instances.json')
  return data
}

/** Runtime overlay, straight through. */
export async function getOverlay({ env = process.env } = {}) {
  const cfg = resolveConfig(env)
  const { data } = await loadWithFallback(cfg.overlay, 'status-overlay.json')
  return data
}

/** Evidence bundle for the /api/t100/evidence endpoint. */
export async function getEvidence({ env = process.env } = {}) {
  const cfg = resolveConfig(env)
  const [{ data, provenance }, team] = await Promise.all([loadEvidence(cfg), loadTeamEvidence(cfg)])
  return { ...data, team, provenance }
}

/**
 * Replay event streams for the /api/t100/events endpoint. These are the two
 * illustrative traces carried as fixtures: a synthetic placed flow and the exact
 * golden XPU trace (logically valid, physically unplaced).
 */
export async function getEvents(name = 'synthetic') {
  const files = { synthetic: 'synthetic-placed-flow.jsonl', golden: 'xpu-transpose-replay.jsonl' }
  const file = files[name]
  if (!file) throw new Error(`unknown event stream: ${name}`)
  const text = await fsp.readFile(fixture(file), 'utf8')
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function invalidateCache() {
  cache = null
}
