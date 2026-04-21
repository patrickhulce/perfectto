import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createReadStream, promises as fs } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

// Mount `./assets/*` at `/assets/*` during dev so the App can fetch the
// checked-in sample traces without bundling them. Production builds
// don't serve this directory — the autoload code path is gated on
// `import.meta.env.DEV` and tree-shakes out.
function serveAssetsDevPlugin() {
  const assetsRoot = resolve(process.cwd(), 'assets')
  const MIME = {
    '.json': 'application/json; charset=utf-8',
  }
  return {
    name: 'perfectto-serve-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/assets', async (req, res, next) => {
        if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
          next()
          return
        }
        // Strip query string; decodeURIComponent for %-escaped names.
        const rawPath = decodeURIComponent(req.url.split('?')[0])
        const normalized = rawPath.replace(/^\/+/, '')
        const filePath = resolve(assetsRoot, normalized)
        // Path-traversal guard: resolved path must stay under assetsRoot.
        if (
          filePath !== assetsRoot &&
          !filePath.startsWith(assetsRoot + sep)
        ) {
          res.statusCode = 403
          res.end('Forbidden')
          return
        }
        try {
          const stat = await fs.stat(filePath)
          if (!stat.isFile()) {
            next()
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream')
          res.setHeader('Content-Length', stat.size)
          res.setHeader('Cache-Control', 'no-cache')
          if (req.method === 'HEAD') {
            res.end()
            return
          }
          createReadStream(filePath).pipe(res)
        } catch {
          next()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serveAssetsDevPlugin()],
})
