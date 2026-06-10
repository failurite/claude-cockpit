// Smoke test: confirm the prebuilt node-pty loads + spawns under Electron's ABI.
// Run with: npx electron scripts/pty-smoke.cjs
const { app } = require('electron')
const pty = require('@homebridge/node-pty-prebuilt-multiarch')

// Echo a token through the platform's shell (there's no `/bin/echo` on Windows).
const isWin = process.platform === 'win32'
const file = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/echo'
const args = isWin ? ['/d', '/s', '/c', 'echo pty-ok'] : ['pty-ok']

app.whenReady().then(() => {
  try {
    const p = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env
    })
    let out = ''
    p.onData((d) => (out += d))
    p.onExit(() => {
      // Windows ConPTY decorates output with control sequences; match the token loosely.
      console.log('PTY_OUTPUT:' + JSON.stringify(out.includes('pty-ok') ? 'pty-ok' : out.trim()))
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
