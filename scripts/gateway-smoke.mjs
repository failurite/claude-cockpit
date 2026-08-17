/**
 * Smoke test for the LAN phone gateway (src/main/gateway.ts).
 * Bundles the source with esbuild (electron kept external — the gateway only
 * calls store.getWorkspaces, no `app` usage) and exercises it over HTTP:
 *   node scripts/gateway-smoke.mjs
 * Prints "SMOKE_RESULT: PASS" when the gateway gates on the token and serves the
 * client + JSON snapshot. No build step required (works off the TS source).
 */
import * as esbuild from 'esbuild'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

const get = (port, p) =>
  new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}${p}`, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => resolve({ code: r.statusCode, body: b }))
    })
  })

// Resolve TS-ESM's explicit ".js" relative imports to their ".ts" source, and
// stub `electron` (the gateway never touches `app`) so it runs under plain Node.
const smokePlugin = {
  name: 'gw-smoke',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const app = { getPath: () => "/tmp" }',
      loader: 'js'
    }))
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      const base = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ''))
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        if (fs.existsSync(base + ext)) return { path: base + ext }
      }
      return undefined
    })
  }
}

const outfile = path.join(os.tmpdir(), 'cockpit-gw-smoke.mjs')
await esbuild.build({
  entryPoints: [path.join('src', 'main', 'gateway.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  plugins: [smokePlugin],
  logLevel: 'silent'
})

const { startGateway } = await import(pathToFileURL(outfile).href)

const manager = new EventEmitter()
manager.list = () => [
  {
    id: 'x', name: 'Smoke session', status: 'working', model: 'claude-opus-5',
    tokensTotal: 1234, subagentCount: 1, workspaceId: null, kind: 'normal',
    issue: null, lastActivity: 'testing'
  }
]
const monitor = new EventEmitter()

let pass = false
try {
  const gw = await startGateway({ manager, monitor, token: 'SECRET', preferredPort: 0 })
  const noToken = await get(gw.port, '/')
  const badToken = await get(gw.port, '/?token=WRONG')
  const root = await get(gw.port, '/?token=SECRET')
  const api = await get(gw.port, '/api/sessions?token=SECRET')

  console.log(
    'unauth:', noToken.code, '| bad:', badToken.code,
    '| root:', root.code, root.body.includes('Cockpit') && root.body.includes('EventSource'),
    '| api:', api.code, api.body.includes('Smoke session')
  )
  pass =
    noToken.code === 401 &&
    badToken.code === 401 &&
    root.code === 200 && root.body.includes('Cockpit') && root.body.includes('EventSource') &&
    api.code === 200 && api.body.includes('Smoke session')
  gw.close()
} catch (e) {
  console.error('smoke error:', e)
}
console.log('SMOKE_RESULT:', pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)
