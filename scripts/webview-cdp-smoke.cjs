// Feasibility spike: can we embed a WebContentsView and DRIVE it via CDP
// (Electron's built-in webContents.debugger) — navigate, run JS, dispatch real
// input, and screenshot — without any external Chrome or extension?
//
// Run: npx electron scripts/webview-cdp-smoke.cjs
// PASS prints "SMOKE_RESULT: PASS ..." and exits 0; any failure exits 1.
const { app, BrowserWindow, WebContentsView } = require('electron')

const FAIL = (msg) => {
  console.error('SMOKE_RESULT: FAIL —', msg)
  app.exit(1)
}
setTimeout(() => FAIL('timeout (15s)'), 15000).unref?.()

// A self-contained page (no network) with a click counter + a text input, so we
// can prove real input dispatch end-to-end, not just navigation.
const PAGE = (label) => `data:text/html,${encodeURIComponent(`
  <html><body style="font:48px sans-serif;margin:40px">
    <h1 id="who">${label}</h1>
    <button id="btn" style="width:300px;height:120px"
      onclick="window.__clicks=(window.__clicks||0)+1;document.title='clicks='+window.__clicks">CLICK</button>
    <input id="box" />
    <script>window.__clicks=0;document.title='ready'</script>
  </body></html>`)}`

const log = (...a) => console.log('[spike]', ...a)

async function driveView(win, label, x, y) {
  log(label, 'create view')
  const view = new WebContentsView()
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 })
  const wc = view.webContents

  log(label, 'loadURL…')
  await wc.loadURL(PAGE(label))
  log(label, 'loaded')

  const dbg = wc.debugger
  dbg.attach('1.3')
  log(label, 'attached')
  await dbg.sendCommand('Page.enable')
  await dbg.sendCommand('Runtime.enable')
  log(label, 'enabled')

  // 1) Read DOM back via CDP (proves observation).
  const titleEval = await dbg.sendCommand('Runtime.evaluate', {
    expression: 'document.querySelector("#who").textContent',
    returnByValue: true
  })
  const seenLabel = titleEval.result.value

  // 2) Dispatch a REAL mouse click at the button via CDP (proves input control).
  for (const type of ['mousePressed', 'mouseReleased']) {
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: 1, buttons: 1
    })
  }
  const clicksEval = await dbg.sendCommand('Runtime.evaluate', {
    expression: 'window.__clicks',
    returnByValue: true
  })
  const clicks = clicksEval.result.value

  // 3) Screenshot the view via CDP (proves we can mirror/preview it too).
  const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })
  const shotBytes = Buffer.from(shot.data, 'base64').length

  dbg.detach()
  return { seenLabel, clicks, shotBytes }
}

app.whenReady().then(async () => {
  try {
    // Offscreen-ish: a real window (CDP input needs a live page) we never focus.
    const win = new BrowserWindow({ width: 1000, height: 700, show: true })

    // Button center is roughly (40+150, ~40+60+120) given the layout/margins.
    const a = await driveView(win, 'TAB-A', 190, 230)
    // Second independent view in the SAME window == a second tab, driven separately.
    const b = await driveView(win, 'TAB-B', 190, 230)

    const ok =
      a.seenLabel === 'TAB-A' && b.seenLabel === 'TAB-B' &&
      a.clicks === 1 && b.clicks === 1 &&
      a.shotBytes > 1000 && b.shotBytes > 1000

    console.log('SMOKE_RESULT:', ok ? 'PASS' : 'FAIL', JSON.stringify({ a, b }))
    app.exit(ok ? 0 : 1)
  } catch (e) {
    FAIL(e && e.stack ? e.stack : String(e))
  }
})
