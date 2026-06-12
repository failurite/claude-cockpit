import { createServer, Server } from 'http'
import type { BrowserManager } from './browser.js'

export interface BrowserRpcServer {
  port: number
  close: () => void
}

/** Request body the MCP shim POSTs: a pane-scoped browser command. */
interface RpcRequest {
  paneId: string
  method: string
  params?: Record<string, unknown>
}

/**
 * Localhost RPC the cockpit-browser MCP shim calls. The shim is a separate
 * process (spawned by Claude), so it reaches the BrowserManager — which lives in
 * the Electron main process and owns the WebContentsViews — over HTTP, tagging
 * every call with its pane id (mirrors the hooks → ingest-server pattern).
 *
 * @param preferredPort fixed port so a session's MCP config keeps reaching us
 *   across app restarts; falls back to an ephemeral port if taken.
 */
export function startBrowserRpc(
  mgr: BrowserManager,
  preferredPort = 0
): Promise<BrowserRpcServer> {
  const dispatch = async (req: RpcRequest): Promise<unknown> => {
    const { paneId, method } = req
    const p = req.params ?? {}
    const tabId = (p.tabId as string | undefined) ?? null
    switch (method) {
      case 'open_tab':
        // agent=true: this load shouldn't steal focus from a terminal the user types in.
        return mgr.openTab(paneId, p.url as string | undefined, true)
      case 'list_tabs':
        return mgr.listTabs(paneId)
      case 'close_tab':
        return mgr.closeTab(paneId, p.tabId as string)
      case 'navigate':
        await mgr.navigate(paneId, tabId, String(p.url ?? ''), true)
        return mgr.listTabs(paneId)
      case 'click':
        await mgr.click(paneId, tabId, String(p.selector ?? ''))
        return { ok: true }
      case 'type':
        await mgr.type(paneId, tabId, String(p.selector ?? ''), String(p.text ?? ''))
        return { ok: true }
      case 'read_text':
        return { text: await mgr.readText(paneId, tabId) }
      case 'screenshot':
        return { pngBase64: await mgr.screenshot(paneId, tabId) }
      default:
        throw new Error(`unknown method: ${method}`)
    }
  }

  return new Promise((resolve, reject) => {
    const server: Server = createServer((reqHttp, res) => {
      if (reqHttp.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let body = ''
      reqHttp.on('data', (c) => {
        body += c
        if (body.length > 5_000_000) reqHttp.destroy()
      })
      reqHttp.on('end', async () => {
        let parsed: RpcRequest
        try {
          parsed = JSON.parse(body) as RpcRequest
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'bad json' }))
          return
        }
        try {
          const result = await dispatch(parsed)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, result }))
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
        }
      })
    })

    const done = (): void => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => server.close() })
    }
    let triedFallback = false
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!triedFallback && preferredPort && err.code === 'EADDRINUSE') {
        triedFallback = true
        server.listen(0, '127.0.0.1', done)
      } else {
        reject(err)
      }
    })
    server.listen(preferredPort, '127.0.0.1', done)
  })
}
