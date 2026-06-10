import { createServer, Server } from 'http'
import type { TerminalSession } from '../shared/types.js'
import { getWorkspaces } from './store.js'
import { sessionDigest } from './transcripts.js'

export interface SessionsRpcServer {
  port: number
  close: () => void
}

/** Request body the cockpit-sessions MCP shim POSTs: a pane-scoped query. */
interface RpcRequest {
  paneId: string
  method: string
  params?: Record<string, unknown>
}

/** Friendly name of the workspace a session belongs to (falls back to its id). */
function workspaceName(workspaceId: string | null): string | null {
  if (!workspaceId) return null
  return getWorkspaces().find((w) => w.id === workspaceId)?.name ?? workspaceId
}

/** Public-facing shape of a sibling session (no transcript content). */
function summarize(s: TerminalSession): Record<string, unknown> {
  return {
    name: s.name,
    workspace: workspaceName(s.workspaceId),
    issue: s.issue ? `#${s.issue.number} ${s.issue.title}` : null,
    branch: s.issue?.branch ?? null,
    cwd: s.cwd,
    status: s.status,
    subagents: s.subagentCount,
    lastActivity: s.lastActivity
  }
}

/**
 * Resolve a user-supplied session reference to a live session. Matches (in order)
 * pane id, exact name (case-insensitive), issue number ("34" / "#34"), then a
 * name substring — so a session can say `read_session("#34")` or `"shutters"`.
 */
function resolve(sessions: TerminalSession[], ref: string): TerminalSession | undefined {
  const r = ref.trim()
  const lower = r.toLowerCase()
  const num = r.replace(/^#/, '')
  return (
    sessions.find((s) => s.id === r) ||
    sessions.find((s) => s.name.toLowerCase() === lower) ||
    (/^\d+$/.test(num) ? sessions.find((s) => s.issue?.number === Number(num)) : undefined) ||
    sessions.find((s) => s.name.toLowerCase().includes(lower))
  )
}

/**
 * Localhost RPC the cockpit-sessions MCP shim calls. Lets a Claude session see
 * its siblings and read a digest of another session's context for coordination.
 * The shim runs in a separate process (spawned by Claude), so it reaches the
 * SessionManager — which lives in the Electron main process — over HTTP, tagging
 * every call with its own pane id (mirrors browser-rpc.ts / the hooks→ingest path).
 *
 * @param getSessions live accessor for the current session list (the manager is
 *   constructed after this server, so we read it lazily at call time).
 * @param preferredPort fixed port so a session's frozen MCP env keeps reaching us
 *   across app restarts; falls back to an ephemeral port if taken.
 */
export function startSessionsRpc(
  getSessions: () => TerminalSession[],
  preferredPort = 0
): Promise<SessionsRpcServer> {
  const dispatch = async (req: RpcRequest): Promise<unknown> => {
    const p = req.params ?? {}
    const all = getSessions()
    switch (req.method) {
      case 'list_sessions':
        // Every session except the caller (and the plumbing-only dev session).
        return all
          .filter((s) => s.id !== req.paneId && s.kind !== 'dev')
          .map(summarize)
      case 'read_session': {
        const ref = String(p.session ?? '').trim()
        if (!ref) throw new Error('missing "session" (a name, #issue, or id)')
        const target = resolve(all, ref)
        if (!target) {
          const names = all.filter((s) => s.id !== req.paneId).map((s) => s.name)
          throw new Error(`no session matches "${ref}". Open sessions: ${names.join(', ') || '(none)'}`)
        }
        if (target.id === req.paneId) throw new Error('that is your own session')
        if (!target.claudeSessionId) {
          return { session: summarize(target), digest: null, note: 'session has no transcript yet' }
        }
        return { session: summarize(target), digest: sessionDigest(target.claudeSessionId) }
      }
      default:
        throw new Error(`unknown method: ${req.method}`)
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
        if (body.length > 2_000_000) reqHttp.destroy()
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
