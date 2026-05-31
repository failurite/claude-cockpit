// Smoke test: confirm the prebuilt node-pty loads + spawns under Electron's ABI.
// Run with: npx electron scripts/pty-smoke.cjs
const { app } = require('electron')
const pty = require('@homebridge/node-pty-prebuilt-multiarch')

app.whenReady().then(() => {
  try {
    const p = pty.spawn('/bin/echo', ['pty-ok'], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env
    })
    let out = ''
    p.onData((d) => (out += d))
    p.onExit(() => {
      console.log('PTY_OUTPUT:' + JSON.stringify(out.trim()))
      app.exit(0)
    })
  } catch (e) {
    console.error('PTY_FAIL:' + e.message)
    app.exit(1)
  }
})
setTimeout(() => {
  console.error('PTY_TIMEOUT')
  app.exit(2)
}, 5000)
