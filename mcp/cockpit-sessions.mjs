#!/usr/bin/env node
// Cockpit's cross-session MCP server. Claude (a normal session) spawns this as a
// stdio MCP server; it lets the session SEE its sibling sessions and READ a digest
// of another session's context, so related bugs can be worked on in coordination.
// Each call is forwarded to the app's sessions RPC endpoint, tagged with this
// pane's id (inherited via env) so the app can exclude "self". Dependency-free +
// fast, like hooks/emit.mjs and cockpit-browser.mjs.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one JSON object/line).
import http from 'node:http'
import readline from 'node:readline'

const PANE_ID = process.env.CLAUDE_COCKPIT_PANE_ID || null
const PORT = Number(process.env.CLAUDE_COCKPIT_SESSIONS_PORT || 0)

/** POST a command to the app's sessions RPC endpoint; resolves with its result. */
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ paneId: PANE_ID, method, params })
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(body)
            json.ok ? resolve(json.result) : reject(new Error(json.error || 'rpc error'))
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// ---- tool catalog -----------------------------------------------------------
const TOOLS = [
  {
    name: 'cockpit_list_sessions',
    description:
      'List the OTHER Claude Code sessions currently open in Cockpit (siblings working in parallel), with each one\'s workspace, GitHub issue/branch, working directory, live status (idle/working/waiting) and recent activity. Use this to discover related in-flight work before or during a task so changes stay coordinated.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'cockpit_read_session',
    description:
      "Read a digest of ANOTHER session's context to coordinate related work: its recent prompts, latest progress, and the files it has been editing. Identify the session by name, issue number (e.g. \"34\" or \"#34\"), or id from cockpit_list_sessions. Read-only — it does not interrupt or message that session.",
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Which session to read: its name, #issue number, or id (see cockpit_list_sessions).'
        }
      },
      required: ['session']
    }
  }
]

/** Render a read_session result as readable text for the model. */
function renderRead(r) {
  const s = r.session || {}
  const lines = []
  lines.push(`Session: ${s.name}${s.issue ? ` — ${s.issue}` : ''}`)
  lines.push(`Workspace: ${s.workspace ?? '—'}   Branch: ${s.branch ?? '—'}`)
  lines.push(`Status: ${s.status} (${s.lastActivity})   Dir: ${s.cwd}`)
  const d = r.digest
  if (!d) {
    lines.push('', r.note || 'No transcript available yet.')
    return lines.join('\n')
  }
  if (d.filesTouched?.length) {
    lines.push('', `Files it has edited (${d.filesTouched.length}):`)
    for (const f of d.filesTouched) lines.push(`  - ${f}`)
  }
  if (d.prompts?.length) {
    lines.push('', 'Recent prompts to that session:')
    for (const p of d.prompts) lines.push(`  • ${p}`)
  }
  if (d.lastAssistant) lines.push('', `Latest progress:\n  ${d.lastAssistant}`)
  return lines.join('\n')
}

/** Run a tool call and shape it into MCP `content` blocks. */
async function callTool(name, args) {
  const a = args || {}
  switch (name) {
    case 'cockpit_list_sessions': {
      const list = await rpc('list_sessions', {})
      if (!Array.isArray(list) || list.length === 0) {
        return text('No other sessions are open in Cockpit right now.')
      }
      return text(JSON.stringify(list, null, 2))
    }
    case 'cockpit_read_session': {
      const r = await rpc('read_session', { session: a.session })
      return text(renderRead(r))
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] })

// ---- JSON-RPC plumbing ------------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cockpit-sessions', version: '0.1.0' }
      })
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call':
      try {
        if (!PANE_ID || !PORT) throw new Error('cockpit sessions not available (missing pane id/port)')
        return reply(id, await callTool(params?.name, params?.arguments))
      } catch (e) {
        // Tool errors are reported in-band so the model can react, not as protocol errors.
        return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true })
      }
    case 'ping':
      return reply(id, {})
    default:
      // Notifications (no id) need no response; unknown requests get a soft error.
      if (id !== undefined) fail(id, `unknown method: ${method}`)
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try {
    msg = JSON.parse(s)
  } catch {
    return
  }
  Promise.resolve(handle(msg)).catch(() => {})
})
