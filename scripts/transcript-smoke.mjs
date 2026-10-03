/**
 * Smoke test for incremental transcript scanning (src/main/transcripts.ts).
 *   node scripts/transcript-smoke.mjs
 * Checks the risky new machinery — byte offsets, partial lines, truncation —
 * by asserting an incrementally-accumulated scan always equals a fresh
 * full-file scan of the same bytes. Also times the real-world win against the
 * largest transcript on disk, if there is one.
 * Prints "SMOKE_RESULT: PASS" on success.
 */
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const outfile = path.join('node_modules', '.cache', 'cockpit-transcripts-smoke.mjs')
fs.mkdirSync(path.dirname(outfile), { recursive: true })
await esbuild.build({
  entryPoints: [path.join('src', 'main', 'transcripts.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['chokidar'],
  outfile,
  logLevel: 'silent'
})
const { scanTranscript, newScanState } = await import(pathToFileURL(path.resolve(outfile)).href)

const file = path.join(os.tmpdir(), `cockpit-transcript-${Date.now()}.jsonl`)
const asst = (tok, model) =>
  JSON.stringify({ message: { role: 'assistant', model, usage: { input_tokens: tok, output_tokens: 1, cache_creation_input_tokens: 0 } } })
const taskOpen = (id) =>
  JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Task', id }] } })
const taskDone = (id) =>
  JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] } })

const full = (f) => scanTranscript(f, newScanState()) // fresh state = whole file
const eq = (a, b) => a.subagents === b.subagents && a.tokens === b.tokens && a.model === b.model
const checks = []

// 1) incremental across several appends == one full parse
fs.writeFileSync(file, [asst(10, 'claude-opus-5'), taskOpen('t1')].join('\n') + '\n')
const st = newScanState()
let inc = scanTranscript(file, st)
fs.appendFileSync(file, [taskOpen('t2'), asst(5, 'claude-opus-5-5')].join('\n') + '\n')
inc = scanTranscript(file, st)
fs.appendFileSync(file, taskDone('t1') + '\n')
inc = scanTranscript(file, st)
checks.push(['incremental == full', eq(inc, full(file))])
checks.push(['tokens summed', inc.tokens === 10 + 1 + 5 + 1])
checks.push(['open subagents', inc.subagents === 1]) // t2 still open
checks.push(['latest model wins', inc.model === 'claude-opus-5-5'])

// 2) a partial trailing line must NOT be consumed, then completes cleanly
const beforePartial = { ...inc }
fs.appendFileSync(file, '{"message":{"role":"assis') // half a line, no newline
const midWrite = scanTranscript(file, st)
checks.push(['partial line ignored', eq(midWrite, beforePartial)])
fs.appendFileSync(file, 'tant","usage":{"output_tokens":7}}}\n') // finish it
const completed = scanTranscript(file, st)
checks.push(['partial line then counted', completed.tokens === beforePartial.tokens + 7])
checks.push(['still == full after partial', eq(completed, full(file))])

// 3) truncation / rewrite resets the running totals instead of double counting
fs.writeFileSync(file, asst(3, 'claude-haiku-4-5') + '\n')
const afterTruncate = scanTranscript(file, st)
checks.push(['truncation resets', eq(afterTruncate, full(file)) && afterTruncate.tokens === 4])

// 4) real-world cost: full re-parse (old behaviour) vs one incremental append
const projects = path.join(os.homedir(), '.claude', 'projects')
let perf = 'skipped (no transcripts found)'
if (fs.existsSync(projects)) {
  let biggest = null
  for (const d of fs.readdirSync(projects)) {
    const dir = path.join(projects, d)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(dir, f)
      const size = fs.statSync(p).size
      if (!biggest || size > biggest.size) biggest = { p, size }
    }
  }
  if (biggest && biggest.size > 1e6) {
    const t0 = Date.now()
    full(biggest.p) // what the old code did on EVERY change event
    const fullMs = Date.now() - t0
    const warm = newScanState()
    scanTranscript(biggest.p, warm) // prime (one-time baseline)
    const t1 = Date.now()
    scanTranscript(biggest.p, warm) // steady-state: nothing new appended
    const incMs = Date.now() - t1
    perf = `${(biggest.size / 1048576).toFixed(1)} MB file: full re-parse ${fullMs} ms → incremental ${incMs} ms`
  }
}

fs.rmSync(file, { force: true })
for (const [name, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
console.log('  perf:', perf)
const pass = checks.every(([, ok]) => ok)
console.log('SMOKE_RESULT:', pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)
