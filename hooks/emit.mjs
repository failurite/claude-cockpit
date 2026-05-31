#!/usr/bin/env node
// Claude Code hook handler installed by claude-cockpit.
// Reads the hook event JSON on stdin, tags it with this pty's pane id (inherited
// via env), and POSTs it to the running app's local ingest server. Always exits 0
// fast so it never blocks or delays a Claude session.
import http from 'node:http'

const TIMEOUT_MS = 1500
const done = () => process.exit(0)
setTimeout(done, TIMEOUT_MS).unref?.()

let body = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (body += c))
process.stdin.on('end', () => {
  const port = process.env.CLAUDE_COCKPIT_INGEST_PORT
  if (!port) return done()

  let evt = {}
  try {
    evt = JSON.parse(body || '{}')
  } catch {
    evt = {}
  }
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
})
