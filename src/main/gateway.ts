import { createServer, Server, ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import type { SessionManager } from './sessions.js'
import type { SystemMonitor } from './monitor.js'
import type { SystemStats, TerminalSession } from '../shared/types.js'
import { getWorkspaces } from './store.js'
import { MOBILE_CLIENT_HTML } from './mobile-client.js'

export interface Gateway {
  port: number
  token: string
  ip: string | null
  /** Full URL to open on a phone (includes the token). */
  url: string
  close: () => void
}

/** Lean, phone-safe view of a session (no launch options / cwd). */
interface SessionSummary {
  id: string
  name: string
  status: string
  model: string | null
  tokensTotal: number
  subagentCount: number
  workspaceId: string | null
  kind: string
  issueNumber: number | null
  lastActivity: string
}

function summarize(sessions: TerminalSession[]): SessionSummary[] {
  return sessions.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    model: s.model,
    tokensTotal: s.tokensTotal,
    subagentCount: s.subagentCount,
    workspaceId: s.workspaceId,
    kind: s.kind,
    issueNumber: s.issue?.number ?? null,
    lastActivity: s.lastActivity
  }))
}

/** id → display name, so the phone can group sessions by workspace. */
function workspaceMap(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const w of getWorkspaces()) out[w.id] = w.name
  return out
}

/** First non-internal IPv4 address (the LAN address a phone can reach). */
function lanAddress(): string | null {
  const ifaces = networkInterfaces()
  // Prefer common Wi-Fi/Ethernet interface names, then anything else.
  const names = Object.keys(ifaces).sort((a, b) => {
    const rank = (n: string): number => (/^en0/.test(n) ? 0 : /^en/.test(n) ? 1 : 2)
    return rank(a) - rank(b)
  })
  for (const name of names) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return null
}

/**
 * The LAN gateway: a token-gated HTTP server (bound to all interfaces) that
 * serves the mobile web client and pushes live session/stat updates over
 * Server-Sent Events. Read-only in Phase 1. SSE is one-directional and needs no
 * extra dependency — perfect for a live dashboard; bidirectional control (pty
 * I/O) comes later over WebSocket.
 */
export function startGateway(opts: {
  manager: SessionManager
  monitor: SystemMonitor
  token: string
  preferredPort?: number
}): Promise<Gateway> {
  const { manager, monitor, token } = opts
  const preferredPort = opts.preferredPort ?? 0

  return new Promise((resolve, reject) => {
    const clients = new Set<ServerResponse>()
    let lastStats: SystemStats | null = null

    const sse = (event: string, data: unknown): string =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const broadcast = (event: string, data: unknown): void => {
      const line = sse(event, data)
      for (const c of clients) c.write(line)
    }

    // One set of upstream listeners fans out to every connected phone.
    const onSessions = (): void => broadcast('sessions', summarize(manager.list()))
    const onStats = (s: SystemStats): void => {
      lastStats = s
      broadcast('stats', s)
    }
    manager.on('sessions', onSessions)
    monitor.on('stats', onStats)

    const authed = (url: URL): boolean => url.searchParams.get('token') === token

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      if (!authed(url)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized')
        return
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(MOBILE_CLIENT_HTML)
        return
      }

      if (url.pathname === '/api/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ sessions: summarize(manager.list()), workspaces: workspaceMap(), stats: lastStats })
        )
        return
      }

      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        res.write('retry: 3000\n\n')
        res.write(
          sse('snapshot', {
            sessions: summarize(manager.list()),
            workspaces: workspaceMap(),
            stats: lastStats
          })
        )
        clients.add(res)
        const hb = setInterval(() => res.write(': hb\n\n'), 20000)
        req.on('close', () => {
          clearInterval(hb)
          clients.delete(res)
        })
        return
      }

      res.writeHead(404).end()
    })

    const finish = (): void => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const ip = lanAddress()
      const url = `http://${ip ?? '127.0.0.1'}:${port}/?token=${token}`
      resolve({
        port,
        token,
        ip,
        url,
        close: () => {
          manager.off('sessions', onSessions)
          monitor.off('stats', onStats)
          for (const c of clients) c.end()
          clients.clear()
          server.close()
        }
      })
    }

    let triedFallback = false
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!triedFallback && preferredPort && err.code === 'EADDRINUSE') {
        triedFallback = true
        server.listen(0, '0.0.0.0', finish) // fall back to an ephemeral LAN port
      } else {
        reject(err)
      }
    })
    server.listen(preferredPort, '0.0.0.0', finish)
  })
}
