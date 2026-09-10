import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
  },
})

/**
 * The hosted build is the same game served by a workspace at `/play`: the page scans the
 * person's own folders and talks to the workspace's colony API instead of the local server.
 * `npm run build:hosted` sets the flag; everything else is the local game as before.
 */
const hosted = process.env.BOT_CROSSING_HOSTED === '1'

export default defineConfig({
  plugins: [api()],
  base: hosted ? '/play/' : '/',
  define: {
    'import.meta.env.VITE_HOSTED': JSON.stringify(hosted ? '1' : ''),
    'import.meta.env.VITE_API_BASE': JSON.stringify(hosted ? '/api/colony' : '/api'),
  },
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: { port: Number(process.env.PORT) || 5274, strictPort: false },
  build: { target: 'esnext' },
})
