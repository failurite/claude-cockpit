/**
 * Smoke test for session sleep/wake (src/main/sessions.ts).
 *   npx electron scripts/sleep-wake-smoke.cjs
 * Uses a plain shell pane (no claude needed) to verify the mechanics:
 *   - a busy session refuses to sleep
 *   - sleeping kills the pty, keeps the pane, and reports status 'asleep'
 *     (NOT 'exited' — the exit handler must not clobber it)
 *   - waking respawns a live pty that produces output again
 * Prints "SMOKE_RESULT: PASS" on success.
 */
const { app } = require('electron')
const path = require('path')
const os = require('os')
const esbuild = require('esbuild')
const fs = require('fs')
const { pathToFileURL } = require('url')

app.whenReady().then(async () => {
  let pass = false
  try {
    // Emit inside the repo so node_modules (node-pty, chokidar) resolve.
    const outfile = path.join(__dirname, '..', 'node_modules', '.cache', 'cockpit-sessions-smoke.mjs')
    fs.mkdirSync(path.dirname(outfile), { recursive: true })
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'main', 'sessions.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['electron', '@homebridge/node-pty-prebuilt-multiarch', 'chokidar'],
      outfile,
      logLevel: 'silent'
    })
    const { SessionManager } = await import(pathToFileURL(outfile).href)

    const mgr = new SessionManager(0)
    // A plain shell pane: `command !== 'claude'`, so sleep() must refuse it —
    // that alone proves the guard. Then we force a claude-shaped pane by hand.
    const shell = mgr.create({ cwd: os.tmpdir(), command: 'bash', name: 'smoke-shell' })
    const refusedNonClaude = mgr.sleep(shell.id) === false

    // Build a claude-shaped pane we can legally sleep: pretend it has a
    // conversation whose transcript exists on disk, and that it's idle.
    const fakeId = 'smoke-conv-' + Date.now()
    const projDir = path.join(os.homedir(), '.claude', 'projects', 'smoke-tmp')
    fs.mkdirSync(projDir, { recursive: true })
    const transcript = path.join(projDir, `${fakeId}.jsonl`)
    fs.writeFileSync(transcript, '{}\n')

    const pane = mgr.create({ cwd: os.tmpdir(), command: 'bash', name: 'smoke-sleeper' })
    const s = mgr.list().find((x) => x.id === pane.id)
    s.command = 'claude' // pretend
    s.claudeSessionId = fakeId
    s.status = 'working'
    const refusedBusy = mgr.sleep(pane.id) === false // busy → refuse

    s.status = 'idle'
    const slept = mgr.sleep(pane.id)
    await new Promise((r) => setTimeout(r, 1200)) // let the pty's onExit fire
    const afterSleep = mgr.list().find((x) => x.id === pane.id).status

    // Wake it: command is 'claude' which doesn't exist as a bash builtin, so use
    // a real command for the relaunch to prove a live pty comes back.
    s.command = 'bash'
    const woke = mgr.wake(pane.id)
    let sawOutput = false
    mgr.on('data', (id) => {
      if (id === pane.id) sawOutput = true
    })
    mgr.write(pane.id, 'echo smoke_alive\n')
    await new Promise((r) => setTimeout(r, 1500))
    const afterWake = mgr.list().find((x) => x.id === pane.id).status

    console.log(
      `refused non-claude: ${refusedNonClaude} | refused busy: ${refusedBusy} |`,
      `slept: ${slept} | status after sleep: ${afterSleep} (must be asleep) |`,
      `woke: ${woke} | status after wake: ${afterWake} | pty output after wake: ${sawOutput}`
    )
    pass =
      refusedNonClaude && refusedBusy && slept && afterSleep === 'asleep' && woke && sawOutput

    fs.rmSync(projDir, { recursive: true, force: true })
    mgr.disposeAll()
  } catch (e) {
    console.error('smoke error:', e)
  }
  console.log('SMOKE_RESULT:', pass ? 'PASS' : 'FAIL')
  app.exit(pass ? 0 : 1)
})
