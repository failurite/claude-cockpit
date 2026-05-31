import { createServer, Server } from 'http'
import type { HookEvent } from '../shared/types.js'

export interface IngestServer {
  port: number
  close: () => void
}

/**
 * Local-only HTTP endpoint that Claude Code hooks POST to. Each hook process
 * inherits CLAUDE_COCKPIT_PANE_ID + CLAUDE_COCKPIT_INGEST_PORT from its pty, so the
 * emit script can tell us which pane fired without us knowing Claude's id yet.
 */
/**
 * @param preferredPort Try this fixed port first (so a persistent tmux-backed
 *   session, whose hook env is frozen at creation, can still reach us after a
 *   restart). Falls back to an OS-assigned ephemeral port if it's taken.
 */
export function startIngestServer(
  onEvent: (e: HookEvent) => void,
  preferredPort = 0
): Promise<IngestServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 1_000_000) req.destroy() // guard
      })
      req.on('end', () => {
        try {
          onEvent(JSON.parse(body) as HookEvent)
        } catch {
          /* ignore malformed */
        }
        res.writeHead(204).end()
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
        server.listen(0, '127.0.0.1', done) // fall back to ephemeral
      } else {
        reject(err)
      }
    })
    server.listen(preferredPort, '127.0.0.1', done)
  })
}
