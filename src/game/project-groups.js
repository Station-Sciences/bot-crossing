/** Pick the direct checkout ahead of nested submodule/build copies of the same remote. */
export function preferredProjectPath(threads) {
  const candidates = new Map()
  for (const thread of threads) {
    const dir = thread.repoPath || thread.projectPath || thread.cwd
    if (!dir) continue
    const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const root = normalize(thread.workspaceRootPath)
    const folder = normalize(dir)
    const current = candidates.get(dir) || { dir, count: 0, latest: 0, insideRoot: false }
    current.count += 1
    current.latest = Math.max(current.latest, thread.lastActivityAt || 0)
    current.insideRoot ||= Boolean(root && (folder === root || folder.startsWith(`${root}/`)))
    candidates.set(dir, current)
  }
  const depth = (value) => value.split(/[\\/]+/).filter(Boolean).length
  return [...candidates.values()]
    .sort((a, b) => (
      Number(b.insideRoot) - Number(a.insideRoot) ||
      depth(a.dir) - depth(b.dir) ||
      a.dir.length - b.dir.length ||
      b.count - a.count ||
      b.latest - a.latest
    ))[0]?.dir || ''
}

/** Carry an old display-name layout forward only when that name has one clear owner. */
export function migrateLegacyPlotCells(plotCells, threads) {
  const keysByName = legacyKeysByName(threads)
  for (const [name, keys] of keysByName) {
    if (keys.size !== 1 || !plotCells.has(name)) continue
    const [key] = keys
    if (!plotCells.has(key)) plotCells.set(key, plotCells.get(name))
    plotCells.delete(name)
  }
  return plotCells
}

/** The same strict migration for the persisted list of hidden plot ids. */
export function migrateLegacyHiddenProjects(hidden, threads) {
  const keysByName = legacyKeysByName(threads)
  const plotKeys = new Set(threads.map((thread) => thread.plotKey).filter(Boolean))
  const out = []
  for (const value of hidden || []) {
    const id = String(value || '')
    if (!id) continue
    const keys = keysByName.get(id)
    const next = !plotKeys.has(id) && keys?.size === 1 ? [...keys][0] : id
    if (!out.includes(next)) out.push(next)
  }
  return out
}

/** Stable plot ids whose every live thread is dormant, unless that would empty the map. */
export function dormantPlotKeys(byProject, isDormant) {
  const dormant = new Set()
  for (const [key, list] of byProject) {
    if (list.every(isDormant)) dormant.add(key)
  }
  if (dormant.size === byProject.size) dormant.clear()
  return dormant
}

function legacyKeysByName(threads) {
  const keysByName = new Map()
  for (const thread of threads) {
    if (!thread.plotKey) continue
    for (const name of new Set([thread.project, thread.legacyProject].filter(Boolean))) {
      if (!keysByName.has(name)) keysByName.set(name, new Set())
      keysByName.get(name).add(thread.plotKey)
    }
  }
  return keysByName
}
