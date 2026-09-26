/**
 * `screen-placement.js` in a plain node:test environment — no real browser, no real
 * `getScreenDetails`, so this only exercises the parts that do not need one: feature
 * detection when the API is absent, and the localStorage round trip.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

// A minimal localStorage so this runs under plain Node, not jsdom.
function fakeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
}

async function freshModule() {
  // Query string defeats the module cache so each test gets its own module-level state,
  // though this module holds none — it reads/writes localStorage on every call.
  return import(`../src/core/screen-placement.js?${Math.random()}`)
}

test('unsupported when the API is entirely absent from window', async () => {
  globalThis.window = { isSecureContext: true }
  const { supported, unavailableReason } = await freshModule()
  assert.equal(supported(), false)
  assert.match(unavailableReason(), /Chrome and Edge/)
  delete globalThis.window
})

test('unsupported over an insecure origin even with the API present', async () => {
  globalThis.window = { isSecureContext: false, getScreenDetails: async () => ({}) }
  const { supported, unavailableReason } = await freshModule()
  assert.equal(supported(), false)
  assert.match(unavailableReason(), /secure context/)
  delete globalThis.window
})

test('a chosen screen round-trips through localStorage', async () => {
  const storage = fakeLocalStorage()
  globalThis.window = {
    isSecureContext: true,
    getScreenDetails: async () => ({
      screens: [
        { isPrimary: false, left: 1920, top: 0, availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1040, label: 'Side monitor' },
        { isPrimary: true, left: 0, top: 0, availLeft: 0, availTop: 0, availWidth: 2560, availHeight: 1400, label: 'Main monitor' },
      ],
    }),
  }
  globalThis.localStorage = storage
  const { chooseMainScreen, savedScreen, clearSavedScreen, supported } = await freshModule()
  assert.equal(supported(), true)
  const bounds = await chooseMainScreen()
  assert.equal(bounds.label, 'Main monitor')
  assert.equal(bounds.width, 2560)
  assert.deepEqual(savedScreen(), bounds)
  clearSavedScreen()
  assert.equal(savedScreen(), null)
  delete globalThis.window
  delete globalThis.localStorage
})

test('a prior permission denial surfaces actionable advice, not the raw DOMException text', async () => {
  globalThis.window = {
    isSecureContext: true,
    getScreenDetails: async () => {
      const err = new Error('denied')
      err.name = 'NotAllowedError'
      throw err
    },
  }
  globalThis.localStorage = fakeLocalStorage()
  const { chooseMainScreen } = await freshModule()
  await assert.rejects(chooseMainScreen(), /Window management/)
  delete globalThis.window
  delete globalThis.localStorage
})
