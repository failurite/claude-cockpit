#!/usr/bin/env node
// Claude Code hook handler installed by claude-cockpit.
// Reads the hook event JSON on stdin, tags it with this pty's pane id (inherited
// via env), and POSTs it to the running app's local ingest server. Always exits 0
// fast so it never blocks or delays a Claude session.
import http from 'node:http'

const TIMEOUT_MS = 1500
const done = () => process.exit(0)
setTimeout(done, TIMEOUT_MS).unref?.()

// On SessionStart in a Cockpit session, inject context so Claude browses via the
// embedded in-app browser (the cockpit-browser MCP `browser_*` tools) instead of
// popping an external/system browser. Claude Code consumes a SessionStart hook's
// stdout as context (JSON `additionalContext` form) — so we ONLY write for this
// one case and stay silent for every other event, to never inject stray text.
const BROWSER_NOTE =
  'This session runs inside Claude Cockpit, which gives it an embedded, in-app web ' +
  'browser via the `cockpit-browser` MCP tools (all named `browser_*`: browser_open_tab, ' +
  'browser_navigate, browser_read_text, browser_screenshot, browser_click, browser_type, ' +
  'browser_list_tabs, browser_close_tab). Use these tools for ALL web browsing — opening ' +
  'pages, navigating, reading page content, screenshots, clicking, and filling web forms — ' +
  "so it stays visible in the user's Cockpit pane. Never open a URL in an external or system " +
  'browser: do not shell out to `open`, `xdg-open`, or `start`, and do not use a ' +
  'Claude-in-Chrome connector. If no `browser_*` tools are available in this session, browsing ' +
  "isn't enabled here — ask the user instead of opening an external browser."

/** Emit the embedded-browser context on SessionStart (Cockpit sessions only), then continue. */
function emitContext(evt, next) {
  if (evt.hook_event_name === 'SessionStart' && process.env.CLAUDE_COCKPIT === '1') {
    const out = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: BROWSER_NOTE }
    })
    // Wait for the write to flush before we might process.exit().
    process.stdout.write(out, next)
  } else {
    next()
  }
}

let body = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (body += c))
process.stdin.on('end', () => {
  let evt = {}
  try {
    evt = JSON.parse(body || '{}')
  } catch {
    evt = {}
  }

  emitContext(evt, () => postEvent(evt))
})

function postEvent(evt) {
  const port = process.env.CLAUDE_COCKPIT_INGEST_PORT
  if (!port) return done()
  evt.cockpit_pane_id = process.env.CLAUDE_COCKPIT_PANE_ID || null

  const payload = JSON.stringify(evt)
  const req = http.request(
    {
      host: '127.0.0.1',
      port: Number(port),
      path: '/',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    },
    (res) => {
      res.resume()
      res.on('end', done)
    }
  )
  req.on('error', done)
  req.write(payload)
  req.end()
}
