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
export function startIngestServer(onEvent: (e: HookEvent) => void): Promise<IngestServer> {
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
    server.on('error', reject)
    // 127.0.0.1 + port 0 => OS picks a free ephemeral port.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => server.close() })
    })
  })
}
