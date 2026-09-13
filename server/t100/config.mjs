import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const FIXTURE_DIR = path.join(here, 'fixtures')

/**
 * Where the T100 world's truth lives on this machine. Every path is
 * env-overridable so the same app can point at a worktree, a colleague's
 * checkout, or (in tests) at nothing and fall back to the bundled snapshot.
 *
 * These are the pinned source locations the plan calls for: the models
 * bringup-ladder tree (manifest + roster + ladder + scorer), the T100 architecture
 * specification's floorplan contract, and the runtime status overlay. None is written to.
 */
const firstExisting = (...candidates) => candidates.find((p) => p && fs.existsSync(p)) || ''

const HOME = process.env.NPH_ROOT || '/Users/greg/nph'

export function resolveConfig(env = process.env) {
  const modelsRepo =
    env.T100_MODELS_REPO ||
    firstExisting(
      path.join(HOME, 'models', '.wt', 'bringup-ladder'),
      path.join(HOME, 'models'),
    )

  const python =
    env.T100_PYTHON ||
    firstExisting(
      modelsRepo && path.join(modelsRepo, '.venv', 'bin', 'python3'),
      '/usr/bin/python3',
    ) ||
    'python3'

  const layout =
    env.T100_LAYOUT ||
    firstExisting(
      path.join(HOME, 'T100_arch_spec', 'ssot', 'floorplan', 'generated', 'instances.json'),
    )

  const overlay =
    env.T100_OVERLAY ||
    firstExisting(
      path.join(HOME, 'models-t100-data', 'viewer_data', 'v1', 'status-overlay.json'),
      modelsRepo && path.join(modelsRepo, 'viewer_data', 'v1', 'status-overlay.json'),
    )

  const weekly =
    env.T100_WEEKLY ||
    firstExisting(modelsRepo && path.join(modelsRepo, 'status', 'weekly.jsonl'))

  const evidenceDir =
    env.T100_EVIDENCE_DIR ||
    firstExisting(modelsRepo && path.join(modelsRepo, 'status', 'evidence'))

  // The reviewed identity join file: canonical unit/rung ids ↔ GitHub/Jira ids.
  // Lives in the models status area; optional until authored.
  const joinFile =
    env.T100_JOIN ||
    firstExisting(
      modelsRepo && path.join(modelsRepo, 'status', 'work-join.json'),
      path.join(FIXTURE_DIR, 'work-join.json'),
    )

  const fidelity = env.T100_FIDELITY || ''

  return {
    modelsRepo,
    python,
    bridgeScript: path.join(here, 'bridge.py'),
    layout,
    overlay,
    weekly,
    evidenceDir,
    joinFile,
    github: {
      enabled: /^(1|true|yes)$/i.test(env.T100_GITHUB_ENABLED || ''),
      api: env.T100_GITHUB_API || 'https://api.github.com',
      token: env.T100_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || '',
    },
    jira: {
      enabled: /^(1|true|yes)$/i.test(env.T100_JIRA_ENABLED || ''),
      url: (env.T100_JIRA_URL || '').replace(/\/+$/, ''),
      email: env.T100_JIRA_EMAIL || '',
      token: env.T100_JIRA_TOKEN || '',
    },
    fidelity,
    fixtureDir: FIXTURE_DIR,
    // How long a built world is served from cache before its inputs are re-checked.
    ttlMs: Number(env.T100_TTL_MS) || 15_000,
    // A source older than this reads as stale in the UI (not blanked).
    staleMs: Number(env.T100_STALE_MS) || 24 * 60 * 60 * 1000,
  }
}
