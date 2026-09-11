import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', 'data')
const PLUGINS_FILE = path.join(DATA_DIR, 'plugins.json')
const LOCAL_PLUGINS_DIR = path.join(here, '..', 'plugins')

/**
 * Lightweight Plugin & Extension Hook Architecture for Bot Crossing.
 *
 * Designed to let the community build modular extensions (custom agent cards, 3D world
 * structures, external task board integrations, authentication / RBAC) without bloating
 * or modifying the core simulator engine.
 *
 * Plugins can live in:
 *   1. Local `./plugins/<id>` directories
 *   2. Installed npm packages (`@beercanlabs/bot-crossing-<id>` or `bot-crossing-<id>`)
 */
class PluginManager {
  constructor() {
    this.state = {
      installed: {},
    }
    this.loadedPlugins = new Map()
    this.loadState()
  }

  loadState() {
    try {
      if (fs.existsSync(PLUGINS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf8'))
        this.state = {
          installed: raw.installed || {},
        }
      }
    } catch (err) {
      console.warn('[PluginManager] Could not read plugins.json:', err.message)
    }
  }

  saveState() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(PLUGINS_FILE, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (err) {
      console.warn('[PluginManager] Could not save plugins.json:', err.message)
    }
  }

  async resolvePluginModule(id) {
    // 1. Check local ./plugins directory
    const localPath = path.join(LOCAL_PLUGINS_DIR, id, 'index.js')
    if (fs.existsSync(localPath)) {
      return await import(pathToFileURL(localPath).href)
    }

    // 2. Check node_modules packages
    const packageNames = [
      `@beercanlabs/bot-crossing-${id}`,
      `bot-crossing-${id}`,
      id,
    ]

    for (const pkg of packageNames) {
      try {
        return await import(pkg)
      } catch {}
    }

    return null
  }

  async init() {
    for (const [id, meta] of Object.entries(this.state.installed)) {
      if (!meta.enabled) continue
      try {
        const mod = await this.resolvePluginModule(id)
        if (mod) {
          const middleware = typeof mod.createMiddleware === 'function'
            ? mod.createMiddleware({ dataDir: DATA_DIR })
            : (typeof mod.default === 'function' ? mod.default({ dataDir: DATA_DIR }) : null)

          this.loadedPlugins.set(id, {
            meta,
            mod,
            middleware,
          })
          console.log(`[PluginManager] Loaded plugin '${id}' (${meta.name || id})`)
        }
      } catch (err) {
        console.warn(`[PluginManager] Failed to load plugin '${id}':`, err.message)
      }
    }
  }

  getPlugin(id) {
    return this.loadedPlugins.get(id)
  }

  isPluginEnabled(id) {
    return !!this.state.installed[id]?.enabled
  }

  async setPluginEnabled(id, enabled, meta = {}) {
    if (!this.state.installed[id]) {
      this.state.installed[id] = {
        id,
        name: meta.name || id,
        enabled: false,
        ...meta,
      }
    }

    this.state.installed[id].enabled = Boolean(enabled)
    this.saveState()

    if (enabled) {
      const mod = await this.resolvePluginModule(id)
      if (mod) {
        const middleware = typeof mod.createMiddleware === 'function'
          ? mod.createMiddleware({ dataDir: DATA_DIR })
          : (typeof mod.default === 'function' ? mod.default({ dataDir: DATA_DIR }) : null)

        this.loadedPlugins.set(id, {
          meta: this.state.installed[id],
          mod,
          middleware,
        })
      }
    } else {
      this.loadedPlugins.delete(id)
    }

    return this.state.installed[id]
  }

  getStatus() {
    return {
      installed: this.state.installed,
    }
  }

  getClientScripts() {
    const scripts = []
    for (const [id, item] of this.loadedPlugins.entries()) {
      const localClientPath = path.join(LOCAL_PLUGINS_DIR, id, 'client', 'index.js')
      if (fs.existsSync(localClientPath)) {
        scripts.push(`/plugins/${id}/client/index.js`)
      } else if (item.mod?.clientScriptUrl) {
        scripts.push(item.mod.clientScriptUrl)
      }
    }
    return scripts
  }

  async middleware(req, res, next) {
    if (this.loadedPlugins.size === 0) {
      return next()
    }

    const plugins = Array.from(this.loadedPlugins.values()).filter((p) => typeof p.middleware === 'function')
    if (plugins.length === 0) {
      return next()
    }

    let index = 0
    const runNext = () => {
      if (index >= plugins.length) {
        return next()
      }
      const plugin = plugins[index++]
      try {
        plugin.middleware(req, res, runNext)
      } catch (err) {
        console.error(`[PluginManager] Middleware error in plugin '${plugin.meta.id}':`, err)
        runNext()
      }
    }

    runNext()
  }
}

export const pluginManager = new PluginManager()
await pluginManager.init()
