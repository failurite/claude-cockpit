/**
 * Smoke test for embedded-browser tab discarding (src/main/browser.ts).
 *   npx electron scripts/tab-discard-smoke.cjs
 * Verifies: a background tab's renderer is torn down by the idle sweep, the tab
 * record survives, and touching it (readText) transparently revives it with its
 * content intact — while the visible tab is never discarded.
 * Prints "SMOKE_RESULT: PASS" on success. Requires `npm run build` first.
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const esbuild = require('esbuild')
const os = require('os')
const { pathToFileURL } = require('url')

const PAGE = 'data:text/html,<body>HELLO_DISCARD</body>'

app.whenReady().then(async () => {
  let pass = false
  try {
    const outfile = path.join(os.tmpdir(), 'cockpit-browser-smoke.mjs')
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'main', 'browser.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['electron'],
      outfile,
      logLevel: 'silent'
    })
    const { BrowserManager } = await import(pathToFileURL(outfile).href)

    const win = new BrowserWindow({ show: false, width: 900, height: 600 })
    const mgr = new BrowserManager()
    mgr.setWindow(win)

    // Two panes: "fg" is foreground+visible, "bg" is a background pane.
    await mgr.openTab('fg', PAGE)
    const bgTab = await mgr.openTab('bg', PAGE)
    mgr.setBounds('fg', { x: 0, y: 0, width: 800, height: 500 })
    mgr.setVisible('fg', true)
    await new Promise((r) => setTimeout(r, 1500)) // let both load

    const before = mgr.listTabs('bg')[0]
    // idleMs=0 → everything not currently visible is eligible.
    const discarded = mgr.sweepIdleTabs(0)
    const bgAfter = mgr.listTabs('bg')[0]
    const fgAfter = mgr.listTabs('fg')[0]

    // Touching a discarded tab must revive it and still return the page text.
    const text = await mgr.readText('bg', bgTab.id)
    const revived = mgr.listTabs('bg')[0]

    console.log(
      `bg loaded: ${JSON.stringify(before.url).slice(0, 24)}… |`,
      `swept: ${discarded} |`,
      `bg discarded: ${bgAfter.discarded} |`,
      `fg discarded (must be false): ${fgAfter.discarded} |`,
      `url kept: ${revived.url === before.url} |`,
      `text after revive: ${text.trim()}`
    )

    pass =
      discarded >= 1 &&
      bgAfter.discarded === true &&
      fgAfter.discarded === false &&
      revived.discarded === false &&
      revived.url === before.url &&
      text.includes('HELLO_DISCARD')
  } catch (e) {
    console.error('smoke error:', e)
  }
  console.log('SMOKE_RESULT:', pass ? 'PASS' : 'FAIL')
  app.exit(pass ? 0 : 1)
})
