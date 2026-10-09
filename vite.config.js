import { defineConfig } from 'vite'
import { apiMiddleware, stopSharing, syncSharing } from './server/api.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
    // Sharing rides along with the dev server: open at start if the colony file says so, and
    // closed with it, so a restart does not find its own old port still bound.
    syncSharing().catch((err) => console.warn('bot-crossing: could not open the share port —', err?.message || err))
    server.httpServer?.once('close', () => stopSharing())
  },
})

export default defineConfig({
  plugins: [api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: { port: Number(process.env.PORT) || 5274, strictPort: false },
  build: { target: 'esnext' },
})
