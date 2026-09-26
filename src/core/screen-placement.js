/**
 * Remembering which physical monitor a popup window should land on.
 *
 * `window.open`'s `left`/`top` features are relative to the whole virtual desktop, but a
 * browser only ever hands JS its *own* window's position — there is no portable way to ask
 * "which screen is the primary one" without the Window Management API
 * (`getScreenDetails`), and that API is gated behind two things at once:
 *
 *   1. A secure context — HTTPS, or `localhost`/`127.0.0.1`. Bot Crossing is typically reached
 *      over plain HTTP at a LAN IP (`http://192.168.x.x:5274`), which Chrome does NOT treat as
 *      secure, so the API is simply absent there until the origin is explicitly trusted (see
 *      `UNAVAILABLE_HINT` below) or the whole app is served over HTTPS.
 *   2. A one-time permission grant, and only from a user gesture — it cannot be requested on
 *      page load, only from a click.
 *
 * So this is opt-in and self-contained: nothing calls it automatically, nothing breaks if the
 * browser refuses, and the chosen screen's bounds are cached in localStorage (this machine and
 * this browser only — never synced to `colony.json`, because "my main monitor" has no meaning
 * on somebody else's screen).
 */

const STORE_KEY = 'botcrossing.mainScreen.v1'

export function supported() {
  return typeof window !== 'undefined' && 'getScreenDetails' in window && window.isSecureContext
}

/** Why the button is disabled, for the settings hint — distinct causes need distinct advice. */
export function unavailableReason() {
  if (typeof window === 'undefined') return ''
  if (!('getScreenDetails' in window)) return 'Only Chrome and Edge support choosing a monitor.'
  if (!window.isSecureContext) {
    return (
      'This page is not a secure context (plain HTTP at a LAN address), which Chrome requires ' +
      'for this API. Either serve Bot Crossing over HTTPS, or add this origin under ' +
      'chrome://flags/#unsafely-treat-insecure-origin-as-secure and relaunch the browser.'
    )
  }
  return ''
}

export function savedScreen() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    return raw && typeof raw.left === 'number' && typeof raw.top === 'number' ? raw : null
  } catch {
    return null
  }
}

export function clearSavedScreen() {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* private mode, quota — nothing to clear anyway */
  }
}

/**
 * Ask the browser which screens exist (prompts for permission the first time — must be called
 * from a click handler), and remember whichever one it reports as primary. Returns the saved
 * bounds on success, or throws with a message fit to show the user directly.
 */
export async function chooseMainScreen() {
  if (!supported()) throw new Error(unavailableReason() || 'Not supported in this browser')
  let details
  try {
    details = await window.getScreenDetails()
  } catch (err) {
    // A prior explicit denial rejects with a NotAllowedError; say what to do about it rather
    // than just relaying the DOMException's generic text.
    throw new Error(
      err?.name === 'NotAllowedError'
        ? 'Permission to see your monitors was denied — check the site settings padlock and allow "Window management", then try again.'
        : err?.message || 'Could not read your monitor layout'
    )
  }
  const primary = details.screens.find((s) => s.isPrimary) || details.currentScreen || details.screens[0]
  if (!primary) throw new Error('No monitor reported')
  const bounds = {
    left: primary.availLeft ?? primary.left ?? 0,
    top: primary.availTop ?? primary.top ?? 0,
    width: primary.availWidth ?? primary.width,
    height: primary.availHeight ?? primary.height,
    label: primary.label || (primary.isPrimary ? 'Primary monitor' : 'Chosen monitor'),
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(bounds))
  } catch {
    /* still usable for this call even if it can't be remembered for next time */
  }
  return bounds
}
