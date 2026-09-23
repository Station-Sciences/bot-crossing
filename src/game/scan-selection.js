/** Browser-safe path helpers — this module runs in the page as well as on the server. */
const PATH_SEP = '/'

function isAbsolutePath(value) {
  if (typeof value !== 'string' || !value) return false
  if (value.startsWith('/')) return true
  if (/^\\\\\?\\[A-Za-z]:[/\\]/.test(value)) return true
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

function normalizeAbsPath(value) {
  if (!value) return ''
  let s = value
  if (/^\\\\\?\\[A-Za-z]:[/\\]/.test(s)) s = s.slice(4)
  s = s.replace(/\\/g, PATH_SEP).replace(/\/+/g, PATH_SEP)
  if (s.length > 1 && s.endsWith(PATH_SEP)) s = s.slice(0, -1)
  if (/^[A-Za-z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1)
  return s
}

function dirnamePath(value) {
  const s = normalizeAbsPath(value)
  const i = s.lastIndexOf(PATH_SEP)
  if (i <= 0) return /^[a-z]:/.test(s) ? s.slice(0, 2) : s
  if (/^[a-z]:/.test(s) && i === 2) return `${s.slice(0, 2)}${PATH_SEP}`
  return s.slice(0, i) || PATH_SEP
}

/** Absolute path for a thread, or empty when unknown. */
export function threadPath(thread) {
  const candidate = thread?.projectPath || thread?.cwd
  if (typeof candidate !== 'string' || !isAbsolutePath(candidate)) return ''
  return normalizeAbsPath(candidate)
}

/** Directory boundary: `/work/foo` matches `/work/foo/bar`, never `/work/foo-bar`. */
export function isUnderRoot(candidate, root) {
  if (!candidate || !root) return false
  const target = normalizeAbsPath(candidate)
  const base = normalizeAbsPath(root)
  if (target === base) return true
  return target.startsWith(base + PATH_SEP)
}

/**
 * What is left out is stored as whole repository paths, matched exactly — never as a folder
 * prefix, and never as the inverse "here is what to include".
 *
 * Storing folders is tidier right up until a repository sits inside another one, which on a
 * real machine they do — a dotfiles checkout at `~` is the common case. Any scheme where one
 * entry stands for a whole subtree lets that outer repository speak for everything under it,
 * and unchecking something inside it is undone on the spot by the entry still covering it.
 * Both directions fail that way, the include list as surely as the prefix.
 *
 * Exact paths cannot, because no entry speaks for a path other than itself. A folder checkbox
 * is then simply every repository under it, and the set only holds what was switched off.
 */
export function normalizeExclusions(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || !isAbsolutePath(item)) continue
    seen.add(normalizeAbsPath(item))
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

export function isPathIncluded(targetPath, excluded) {
  if (!targetPath || !excluded?.length) return true
  return !excluded.includes(normalizeAbsPath(targetPath))
}

export function isThreadIncluded(thread, excluded) {
  return isPathIncluded(threadPath(thread), excluded)
}

export function repoPathsFromThreads(threads) {
  const seen = new Set()
  for (const thread of threads) {
    const p = threadPath(thread)
    if (p) seen.add(p)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** `/`, or a bare Windows drive — a place nobody keeps projects, only a place they start. */
function isFilesystemRoot(value) {
  const s = normalizeAbsPath(value)
  return s === PATH_SEP || /^[a-z]:\/?$/.test(s)
}

/**
 * Nested folder tree for discovered repository paths. Folders carry `path`; leaves are repos.
 *
 * Every repository is linked all the way up to its filesystem root rather than to the deepest
 * folder they happen to share. Anchoring on the shared folder reads well right up until one
 * project sits somewhere else entirely — a checkout under `/private/tmp` alongside everything
 * in `~` leaves `/` as the only common ancestor, and the tree flattens into a list of absolute
 * paths. Linking to the root always, and folding the empty middle away afterwards, gives the
 * same short tree in the ordinary case and a real tree in the awkward one.
 */
export function buildScanTree(repoPaths) {
  /** @type {Map<string, { path: string, repos: string[], subdirs: Set<string> }>} */
  const nodes = new Map()

  const ensure = (folderPath) => {
    if (!nodes.has(folderPath)) {
      nodes.set(folderPath, { path: folderPath, repos: [], subdirs: new Set() })
    }
    return nodes.get(folderPath)
  }

  for (const repo of repoPaths.map((p) => normalizeAbsPath(p))) {
    ensure(repo).repos.push(repo)
    let child = repo
    let parent = dirnamePath(repo)
    // `dirnamePath` is its own fixed point at the root, which is what ends the walk.
    while (parent !== child) {
      ensure(child)
      ensure(parent).subdirs.add(child)
      child = parent
      parent = dirnamePath(parent)
    }
    ensure(child)
  }

  for (const node of nodes.values()) {
    node.repos.sort((a, b) => a.localeCompare(b))
    node.subdirs = new Set([...node.subdirs].sort((a, b) => a.localeCompare(b)))
  }

  const roots = [...nodes.keys()]
    .filter((p) => {
      const parent = dirnamePath(p)
      return parent === p || !nodes.has(parent)
    })
    .sort((a, b) => a.localeCompare(b))

  return { nodes, roots }
}

function baseName(value) {
  const s = normalizeAbsPath(value)
  const i = s.lastIndexOf(PATH_SEP)
  return i < 0 ? s : s.slice(i + 1) || s
}

/**
 * The tree as it should be *drawn*, which is not the tree as it is stored.
 *
 * A checkout six levels below home produces six nested rows, five of which have exactly one
 * child and so say nothing — in a 320px panel that is the whole width spent on indentation
 * before the first name appears. A folder with a single child is therefore folded into it and
 * the two names are joined, the way a file browser shows `a/b/c` for a chain nobody can branch
 * at. The node keeps the *deepest* path of the chain: every path in a single-child run stands
 * for exactly the same repositories, so ticking any of them is the same tick.
 */
export function buildDisplayTree(repoPaths) {
  const { nodes, roots } = buildScanTree(repoPaths)

  const build = (path, seedLabel) => {
    const node = nodes.get(path)
    const isRepo = Boolean(node?.repos.includes(path))
    const childPaths = []
    if (node) {
      for (const sub of node.subdirs) childPaths.push(sub)
      for (const repo of node.repos) {
        if (repo !== path && !node.subdirs.has(repo)) childPaths.push(repo)
      }
    }
    childPaths.sort((a, b) => a.localeCompare(b))

    let out = {
      path,
      label: seedLabel ?? baseName(path),
      isRepo,
      children: childPaths.map((child) => build(child)),
    }
    while (!out.isRepo && out.children.length === 1) {
      const only = out.children[0]
      const joiner = out.label.endsWith(PATH_SEP) ? '' : PATH_SEP
      out = {
        path: only.path,
        label: `${out.label}${joiner}${only.label}`,
        isRepo: only.isRepo,
        children: only.children,
      }
    }
    return out
  }

  const out = []
  for (const root of roots) {
    const built = build(root, root)
    // Everything folded away above the first branch, leaving the filesystem root itself as a
    // row. It is not a place anybody keeps projects, so its branches become the top rows.
    if (isFilesystemRoot(built.path) && built.children.length) out.push(...built.children)
    else out.push(built)
  }
  return out
}

export function reposUnder(targetPath, repoPaths) {
  return repoPaths.filter((p) => isUnderRoot(p, targetPath) || p === targetPath)
}

/** `checked`, `unchecked`, or `mixed` — read off the repositories the row stands for. */
export function selectionState(targetPath, repoPaths, excluded) {
  const under = reposUnder(targetPath, repoPaths)
  if (!under.length) return 'checked'
  const off = under.filter((p) => !isPathIncluded(p, excluded))
  if (!off.length) return 'checked'
  if (off.length === under.length) return 'unchecked'
  return 'mixed'
}

/**
 * Tick or untick a row, which means ticking every repository beneath it. A folder is not
 * itself stored — only the repositories are — so a row's state is always recomputed from its
 * descendants rather than remembered, and the two can never disagree.
 */
export function toggleSelection(targetPath, checked, repoPaths, excluded) {
  const next = new Set(normalizeExclusions(excluded))
  for (const repo of reposUnder(targetPath, repoPaths)) {
    if (checked) next.delete(repo)
    else next.add(repo)
  }
  return [...next].sort((a, b) => a.localeCompare(b))
}
