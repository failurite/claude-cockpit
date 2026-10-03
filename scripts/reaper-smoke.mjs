/**
 * Smoke test for the worktree process reaper (src/main/reaper.ts).
 *   node scripts/reaper-smoke.mjs
 * Spawns throwaway processes whose cwd is inside a temp dir (one of them a
 * grandchild via a shell, mirroring the tmux→npm→node chain that leaked),
 * verifies pidsUnder() finds them by cwd, reaps them, and confirms they're gone.
 * Prints "SMOKE_RESULT: PASS" on success.
 */
import * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const outfile = path.join(os.tmpdir(), 'cockpit-reaper-smoke.mjs')
await esbuild.build({
  entryPoints: [path.join('src', 'main', 'reaper.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
  plugins: [
    {
      name: 'ts-js',
      setup(b) {
        b.onResolve({ filter: /^\.\.?\// }, (args) => {
          const base = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ''))
          for (const ext of ['.ts', '/index.ts']) {
            if (fs.existsSync(base + ext)) return { path: base + ext }
          }
          return undefined
        })
      }
    }
  ]
})
const { pidsUnder, reapUnder } = await import(pathToFileURL(outfile).href)

// A directory that stands in for a per-issue worktree, plus a sibling we must NOT touch.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-wt-'))
const safeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-safe-'))

const kids = [
  spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { cwd: dir, stdio: 'ignore' }),
  // Grandchild through a shell: the shape that actually leaked (pty→tmux→npm→node).
  spawn('/bin/bash', ['-c', `exec "${process.execPath}" -e 'setInterval(()=>{},1e9)'`], {
    cwd: dir,
    stdio: 'ignore'
  })
]
const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {
  cwd: safeDir,
  stdio: 'ignore'
})

await new Promise((r) => setTimeout(r, 1200)) // let cwds settle

let pass = false
try {
  const found = await pidsUnder([dir])
  const foundMine = kids.filter((k) => found.includes(k.pid)).length
  const leakedBystander = found.includes(bystander.pid)

  const reaped = await reapUnder([dir])
  await new Promise((r) => setTimeout(r, 600))

  const aliveAfter = kids.filter((k) => {
    try {
      process.kill(k.pid, 0)
      return true
    } catch {
      return false
    }
  }).length
  let bystanderAlive = false
  try {
    process.kill(bystander.pid, 0)
    bystanderAlive = true
  } catch {
    /* died unexpectedly */
  }

  console.log(
    `found ${foundMine}/2 by cwd | bystander matched: ${leakedBystander} |`,
    `reaped ${reaped} | alive after: ${aliveAfter} | bystander still alive: ${bystanderAlive}`
  )
  pass = foundMine === 2 && !leakedBystander && aliveAfter === 0 && bystanderAlive
} catch (e) {
  console.error('smoke error:', e)
} finally {
  try {
    bystander.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  for (const k of kids) {
    try {
      k.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(safeDir, { recursive: true, force: true })
}
console.log('SMOKE_RESULT:', pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)
