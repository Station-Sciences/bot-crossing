import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanThreads } from './scan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', 'data')
const PLUGINS_FILE = path.join(DATA_DIR, 'plugins.json')
const LOCAL_PLUGINS_DIR = path.join(here, '..', 'plugins')
const MONOREPO_PACKAGES_DIR = path.join(here, '..', '..', 'bot-crossing-plugins', 'packages')

const REMOTE_REGISTRY_URL = 'https://raw.githubusercontent.com/BeerCanLabs/bot-crossing-plugins/main/registry.json'

export class PluginManager {
  constructor() {
    this.state = {
      installed: {}
    }
    this.loadedPlugins = new Map()
    this.cachedCatalog = []
    this.lastCatalogFetch = 0
    this.loadState()
  }

  loadState() {
    try {
      if (fs.existsSync(PLUGINS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf-8'))
        if (raw.installed) {
          this.state.installed = { ...raw.installed }
        }
      }
    } catch (err) {
      console.warn('[PluginManager] Failed to read plugins.json:', err.message)
    }
  }

  saveState() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(PLUGINS_FILE, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[PluginManager] Failed to save plugins.json:', err.message)
    }
  }

  /**
   * Dynamically resolves the plugin catalog from remote registry or local directories.
   * Caches for 60 seconds.
   */
  async fetchCatalog() {
    const now = Date.now()
    if (this.cachedCatalog.length > 0 && now - this.lastCatalogFetch < 60000) {
      return this.cachedCatalog
    }

    const catalogMap = new Map()

    // 1. Scan local ./plugins directory
    if (fs.existsSync(LOCAL_PLUGINS_DIR)) {
      try {
        const entries = fs.readdirSync(LOCAL_PLUGINS_DIR)
        for (const id of entries) {
          const pJson = path.join(LOCAL_PLUGINS_DIR, id, 'plugin.json')
          if (fs.existsSync(pJson)) {
            const meta = JSON.parse(fs.readFileSync(pJson, 'utf-8'))
            catalogMap.set(meta.id || id, {
              ...meta,
              id: meta.id || id,
              repo: meta.repo || `https://github.com/BeerCanLabs/bot-crossing-plugins/tree/main/packages/${meta.id || id}`
            })
          }
        }
      } catch (err) {
        console.warn('[PluginManager] Error scanning local ./plugins:', err.message)
      }
    }

    // 2. Scan sibling monorepo packages (for local development)
    if (fs.existsSync(MONOREPO_PACKAGES_DIR)) {
      try {
        const entries = fs.readdirSync(MONOREPO_PACKAGES_DIR)
        for (const id of entries) {
          const pJson = path.join(MONOREPO_PACKAGES_DIR, id, 'plugin.json')
          if (fs.existsSync(pJson)) {
            const meta = JSON.parse(fs.readFileSync(pJson, 'utf-8'))
            catalogMap.set(meta.id || id, {
              ...meta,
              id: meta.id || id,
              repo: meta.repo || `https://github.com/BeerCanLabs/bot-crossing-plugins/tree/main/packages/${meta.id || id}`
            })
          }
        }
      } catch (err) {
        console.warn('[PluginManager] Error scanning monorepo packages:', err.message)
      }
    }

    // 3. Dynamic Remote Registry (BeerCanLabs/bot-crossing-plugins)
    try {
      const res = await fetch(REMOTE_REGISTRY_URL, { headers: { 'User-Agent': 'Bot-Crossing-PluginManager' } })
      if (res.ok) {
        const data = await res.json()
        const remoteCatalog = Array.isArray(data) ? data : data.catalog || []
        for (const item of remoteCatalog) {
          if (item && item.id) {
            catalogMap.set(item.id, {
              ...item,
              repo: item.repo || `https://github.com/BeerCanLabs/bot-crossing-plugins/tree/main/packages/${item.id}`
            })
          }
        }
      }
    } catch (err) {
      console.warn('[PluginManager] Could not reach remote plugin registry:', err.message)
    }

    this.cachedCatalog = Array.from(catalogMap.values())
    this.lastCatalogFetch = now
    return this.cachedCatalog
  }

  async resolvePluginModule(id) {
    // 1. Check local monorepo sibling path
    const localMonorepoPath = path.join(MONOREPO_PACKAGES_DIR, id, 'index.js')
    if (fs.existsSync(localMonorepoPath)) {
      return await import(pathToFileURL(localMonorepoPath).href)
    }

    // 2. Check local ./plugins directory
    const localPluginsPath = path.join(LOCAL_PLUGINS_DIR, id, 'index.js')
    if (fs.existsSync(localPluginsPath)) {
      return await import(pathToFileURL(localPluginsPath).href)
    }

    // 3. Fallback to installed npm packages
    const packageCandidates = [
      `@beercanlabs/bot-crossing-${id}`,
      `bot-crossing-${id}`,
      id
    ]

    for (const pkg of packageCandidates) {
      try {
        return await import(pkg)
      } catch {}
    }

    return null
  }

  createPluginMiddleware(id, mod) {
    if (!mod) return null
    const factory = mod.createMiddleware ||
                    mod.createRbacMiddleware ||
                    mod.createTaskBoardMiddleware ||
                    mod.createMusicMiddleware ||
                    mod.createAgentCardsMiddleware ||
                    (typeof mod.default === 'function' ? mod.default : null)

    if (typeof factory === 'function') {
      try {
        return factory({
          dataDir: DATA_DIR,
          scanThreads,
          scanCronJobs: async () => []
        })
      } catch (err) {
        console.warn(`[PluginManager] Error constructing middleware for '${id}':`, err.message)
      }
    }
    return null
  }

  async init() {
    // Seed default plugins if none installed yet
    if (Object.keys(this.state.installed).length === 0) {
      this.state.installed = {
        billboard: { id: 'billboard', name: 'Task Board Billboard', enabled: true, category: 'world-structure' },
        rbac: { id: 'rbac', name: 'Role-Based Access Control', enabled: true, category: 'security' },
        'agent-cards': { id: 'agent-cards', name: 'Custom Agent Cards', enabled: true, category: 'agent-interface' }
      }
      this.saveState()
    }

    for (const [id, meta] of Object.entries(this.state.installed)) {
      if (!meta.enabled) continue
      try {
        const mod = await this.resolvePluginModule(id)
        if (mod) {
          this.loadedPlugins.set(id, {
            meta,
            mod,
            middleware: this.createPluginMiddleware(id, mod)
          })
          console.log(`[PluginManager] Loaded plugin '${id}' (${meta.name || id})`)
        } else {
          // Pure client-side or remote-served plugin (active)
          this.loadedPlugins.set(id, {
            meta,
            mod: null,
            middleware: null
          })
          console.log(`[PluginManager] Registered client plugin '${id}' (${meta.name || id})`)
        }
      } catch (err) {
        console.warn(`[PluginManager] Could not load plugin '${id}':`, err.message)
      }
    }
  }

  getPlugin(id) {
    return this.loadedPlugins.get(id)
  }

  isPluginEnabled(id) {
    return !!this.state.installed[id]?.enabled
  }

  async setPluginEnabled(id, enabled) {
    if (!this.state.installed[id]) {
      const catalog = await this.fetchCatalog()
      const catalogItem = catalog.find((c) => c.id === id)
      if (catalogItem) {
        this.state.installed[id] = {
          id: catalogItem.id,
          name: catalogItem.name,
          enabled: false,
          category: catalogItem.category || 'addon',
          icon: catalogItem.icon
        }
      } else {
        this.state.installed[id] = {
          id,
          name: id,
          enabled: false,
          category: 'addon'
        }
      }
    }

    this.state.installed[id].enabled = Boolean(enabled)
    this.saveState()

    if (enabled) {
      const mod = await this.resolvePluginModule(id)
      this.loadedPlugins.set(id, {
        meta: this.state.installed[id],
        mod,
        middleware: this.createPluginMiddleware(id, mod)
      })
    } else {
      this.loadedPlugins.delete(id)
    }

    return this.state.installed[id]
  }

  async getStatus() {
    const catalog = await this.fetchCatalog()
    return {
      installed: this.state.installed,
      catalog: catalog.map((cat) => ({
        ...cat,
        isInstalled: Boolean(this.state.installed[cat.id]),
        isEnabled: Boolean(this.state.installed[cat.id]?.enabled)
      }))
    }
  }

  getClientScripts() {
    const scripts = []
    for (const [id, item] of this.loadedPlugins.entries()) {
      const localClientPath = path.join(LOCAL_PLUGINS_DIR, id, 'client', 'index.js')
      const monorepoClientPath = path.join(MONOREPO_PACKAGES_DIR, id, 'client', 'index.js')
      if (fs.existsSync(localClientPath) || fs.existsSync(monorepoClientPath)) {
        scripts.push(`/plugins/${id}/client/index.js`)
      } else if (item.mod?.clientScriptUrl) {
        scripts.push(item.mod.clientScriptUrl)
      } else {
        // Universal dynamic remote fallback (serves from /plugins/:id/client/index.js)
        scripts.push(`/plugins/${id}/client/index.js`)
      }
    }
    return scripts
  }

  /**
   * Generic middleware dispatcher for all loaded plugins
   */
  async middleware(req, res, next) {
    const activePlugins = Array.from(this.loadedPlugins.values()).filter(
      (p) => typeof p.middleware === 'function'
    )
    if (activePlugins.length === 0) return next ? next() : undefined

    let index = 0
    const dispatch = () => {
      if (index >= activePlugins.length) {
        return next ? next() : undefined
      }
      const plugin = activePlugins[index++]
      try {
        plugin.middleware(req, res, dispatch)
      } catch (err) {
        console.error(`[PluginManager] Middleware error in plugin '${plugin.meta.id}':`, err)
        dispatch()
      }
    }

    dispatch()
  }
}

export const pluginManager = new PluginManager()
await pluginManager.init()
