#!/usr/bin/env node
// Cockpit's embedded-browser MCP server. Claude (a normal session) spawns this
// as a stdio MCP server; it forwards each tool call to the app's browser RPC
// endpoint, tagged with this pane's id (inherited via env), so the call drives
// THIS session's embedded WebContentsView tabs. Dependency-free + fast, like
// hooks/emit.mjs.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one JSON object/line).
import http from 'node:http'
import readline from 'node:readline'

const PANE_ID = process.env.CLAUDE_COCKPIT_PANE_ID || null
const PORT = Number(process.env.CLAUDE_COCKPIT_BROWSER_PORT || 0)

/** POST a command to the app's browser RPC endpoint; resolves with its result. */
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
    name: 'browser_open_tab',
    description: "Open a new tab in this session's embedded browser (optionally at a URL) and make it active.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open (default about:blank)' } }
    }
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab (defaults to the active tab) to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        tabId: { type: 'string', description: 'Target tab id; omit for the active tab' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_list_tabs',
    description: "List the tabs open in this session's embedded browser.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab by id.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }
  },
  {
    name: 'browser_click',
    description: 'Click the first element matching a CSS selector in a tab (defaults to the active tab).',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, tabId: { type: 'string' } },
      required: ['selector']
    }
  },
  {
    name: 'browser_type',
    description: 'Type text into an input/textarea matching a CSS selector (defaults to the active tab).',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' }, tabId: { type: 'string' } },
      required: ['selector', 'text']
    }
  },
  {
    name: 'browser_read_text',
    description: 'Return the visible text of a tab (defaults to the active tab).',
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } }
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of a tab (defaults to the active tab).',
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } }
  }
]

/** Run a tool call and shape it into MCP `content` blocks. */
async function callTool(name, args) {
  const a = args || {}
  switch (name) {
    case 'browser_open_tab': {
      const tab = await rpc('open_tab', { url: a.url })
      return text(`Opened tab ${tab.id} → ${tab.url}`)
    }
    case 'browser_navigate': {
      const tabs = await rpc('navigate', { url: a.url, tabId: a.tabId })
      return text(`Navigated to ${a.url}. Tabs: ${JSON.stringify(tabs)}`)
    }
    case 'browser_list_tabs':
      return text(JSON.stringify(await rpc('list_tabs', {}), null, 2))
    case 'browser_close_tab': {
      const tabs = await rpc('close_tab', { tabId: a.tabId })
      return text(`Closed ${a.tabId}. Remaining: ${JSON.stringify(tabs)}`)
    }
    case 'browser_click':
      await rpc('click', { selector: a.selector, tabId: a.tabId })
      return text(`Clicked ${a.selector}`)
    case 'browser_type':
      await rpc('type', { selector: a.selector, text: a.text, tabId: a.tabId })
      return text(`Typed into ${a.selector}`)
    case 'browser_read_text': {
      const { text: t } = await rpc('read_text', { tabId: a.tabId })
      return text(t || '(empty)')
    }
    case 'browser_screenshot': {
      const { pngBase64 } = await rpc('screenshot', { tabId: a.tabId })
      return { content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }] }
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
        serverInfo: { name: 'cockpit-browser', version: '0.1.0' }
      })
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call':
      try {
        if (!PANE_ID || !PORT) throw new Error('cockpit browser not available (missing pane id/port)')
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
