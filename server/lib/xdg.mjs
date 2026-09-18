/**
 * Linux desktop plumbing: does anything on this machine answer a URL scheme?
 *
 * Only `server/api.mjs` uses this, and only on Linux. It is split out because it is a page of
 * desktop-environment trivia with nothing to do with HTTP, and nothing in here knows about a
 * particular harness — an adapter never imports it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The scheme of a URL, or '' if it does not parse. */
export function schemeOf(url) {
  try {
    return new URL(url).protocol.replace(/:$/, '')
  } catch {
    return ''
  }
}

/**
 * Is a desktop app registered for this URL's scheme?
 *
 * `xdg-mime query default x-scheme-handler/<scheme>` is what `xdg-open` itself consults. It
 * checks that a `mimeapps.list` entry still points at an installed .desktop file, which is the
 * common stale case — an uninstalled app leaves its line behind — though its `mimeinfo.cache`
 * fallback takes an entry on trust, exactly as xdg-open would.
 *
 * Anything that stops the query counts as "no handler": the alternative is handing xdg-open a
 * URL nothing answers, which fails silently and reaches the page as "Opened".
 */
export async function schemeHasHandler(url) {
  const scheme = schemeOf(url)
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return false
  try {
    // Bounded: on KDE the query goes through the trader, which can sit on a D-Bus timeout.
    const args = ['query', 'default', `x-scheme-handler/${scheme}`]
    const { stdout } = await execFileAsync('xdg-mime', args, { timeout: 5000 })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}
