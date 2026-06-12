import { EventEmitter } from 'events'
import { WebContentsView, BrowserWindow, session } from 'electron'
import type { BrowserTab, BrowserBounds } from '../shared/types.js'

/** Where a freshly-opened tab points when no URL is given. */
const HOME = 'about:blank'

/**
 * Shared, persistent profile for every embedded tab across all sessions: logins
 * and cookies survive restarts, so you sign into Google (or any site) ONCE in
 * the embedded browser and stay authenticated everywhere in Cockpit. (We never
 * import Chrome's saved passwords — that store is OS-keychain encrypted and not
 * exposed to apps; embedded Chromium also has no password-manager autofill.)
 */
const PARTITION = 'persist:cockpit-browser'

interface Tab {
  id: string
  view: WebContentsView
  title: string
  url: string
  loading: boolean
  /** This load was started by the agent (RPC), not the user — bounce focus back
   *  to the host window when it finishes so it can't steal terminal typing. */
  agentLoad?: boolean
}

interface PaneBrowser {
  tabs: Tab[]
  activeTabId: string | null
  bounds: BrowserBounds | null
}

/**
 * Owns each session's embedded browser: a set of WebContentsViews (= tabs)
 * overlaid on the main window. Only the *foreground* pane's *active* tab is
 * shown, positioned over the rectangle the renderer reserves for it. Claude
 * drives tabs out-of-process via the browser RPC endpoint (see browser-rpc.ts).
 *
 * Emits: 'tabs' (paneId, BrowserTab[]) whenever a pane's tab set/state changes.
 */
export class BrowserManager extends EventEmitter {
  private panes = new Map<string, PaneBrowser>()
  private win: BrowserWindow | null = null
  /** The single pane whose browser is currently visible (others are hidden). */
  private foreground: string | null = null
  private seq = 0

  constructor() {
    super()
    // Present as plain Chrome (drop the "Electron"/app tokens) so sign-in pages —
    // notably Google — don't reject the embedded browser as "not secure".
    const ses = session.fromPartition(PARTITION)
    const ua = ses
      .getUserAgent()
      .replace(/ Claude Cockpit\/\S+/, '')
      .replace(/ Electron\/\S+/, '')
    ses.setUserAgent(ua)
  }

  /** The window WebContentsViews attach to. Set once the main window exists. */
  setWindow(win: BrowserWindow): void {
    this.win = win
    // Attach any views created before the window existed (e.g. restored on boot,
    // since restore() runs before createWindow()).
    for (const pb of this.panes.values()) {
      for (const t of pb.tabs) win.contentView.addChildView(t.view)
    }
    this.relayout()
  }

  /** Reopen a set of persisted tabs for a pane, preserving which one was active. */
  async restoreTabs(paneId: string, tabs: { url: string; active: boolean }[]): Promise<void> {
    let activeId: string | null = null
    for (const t of tabs) {
      const opened = await this.openTab(paneId, t.url)
      if (t.active) activeId = opened.id
    }
    if (activeId) this.activateTab(paneId, activeId)
  }

  // ---- public API (mirrors CockpitApi.browser) ----------------------------

  listTabs(paneId: string): BrowserTab[] {
    const pb = this.panes.get(paneId)
    if (!pb) return []
    return pb.tabs.map((t) => this.toPublic(pb, t))
  }

  async openTab(paneId: string, url = HOME, agent = false): Promise<BrowserTab> {
    const pb = this.ensure(paneId)
    const view = new WebContentsView({ webPreferences: { partition: PARTITION } })
    const tab: Tab = { id: `tab-${++this.seq}`, view, title: url, url, loading: true, agentLoad: agent }
    pb.tabs.push(tab)
    pb.activeTabId = tab.id

    const wc = view.webContents
    const sync = (): void => this.emitTabs(paneId)
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title
      sync()
    })
    wc.on('did-start-loading', () => {
      tab.loading = true
      sync()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      tab.url = wc.getURL()
      tab.title = wc.getTitle() || tab.url
      // A page load grabs OS keyboard focus for this native view. If the agent
      // (not the user) triggered it, hand focus back to the host window so it
      // can't interrupt the user typing in a terminal.
      if (tab.agentLoad) {
        tab.agentLoad = false
        this.focusHost()
      }
      sync()
    })
    // Keep navigations the page initiates (links, redirects) in this same view.
    wc.setWindowOpenHandler(({ url: target }) => {
      void wc.loadURL(target)
      return { action: 'deny' }
    })

    if (this.win) this.win.contentView.addChildView(view)
    this.relayout()
    void this.safeLoad(tab, url)
    this.emitTabs(paneId)
    return this.toPublic(pb, tab)
  }

  closeTab(paneId: string, tabId: string): BrowserTab[] {
    const pb = this.panes.get(paneId)
    if (!pb) return []
    const i = pb.tabs.findIndex((t) => t.id === tabId)
    if (i === -1) return this.listTabs(paneId)
    const [tab] = pb.tabs.splice(i, 1)
    this.destroyView(tab)
    if (pb.activeTabId === tabId) pb.activeTabId = pb.tabs[Math.max(0, i - 1)]?.id ?? null
    this.relayout()
    this.emitTabs(paneId)
    return this.listTabs(paneId)
  }

  activateTab(paneId: string, tabId: string): BrowserTab[] {
    const pb = this.panes.get(paneId)
    if (pb && pb.tabs.some((t) => t.id === tabId)) {
      pb.activeTabId = tabId
      this.relayout()
      this.emitTabs(paneId)
    }
    return this.listTabs(paneId)
  }

  async navigate(paneId: string, tabId: string | null, url: string, agent = false): Promise<void> {
    const tab = this.resolveTab(paneId, tabId)
    if (!tab) throw new Error('no such tab')
    tab.agentLoad = agent // did-stop-loading bounces focus to the host if agent-driven
    await this.safeLoad(tab, url)
  }

  setBounds(paneId: string, bounds: BrowserBounds | null): void {
    const pb = this.ensure(paneId)
    pb.bounds = bounds
    this.relayout()
  }

  /** Make `paneId` the foreground browser (visible == true) or hide it. */
  setVisible(paneId: string, visible: boolean): void {
    if (visible) this.foreground = paneId
    else if (this.foreground === paneId) this.foreground = null
    this.relayout()
  }

  /** Drop a pane's whole browser (called when its session closes). */
  disposePane(paneId: string): void {
    const pb = this.panes.get(paneId)
    if (!pb) return
    for (const t of pb.tabs) this.destroyView(t)
    this.panes.delete(paneId)
    if (this.foreground === paneId) this.foreground = null
  }

  // ---- control surface used by the RPC endpoint ---------------------------

  /** Read the visible text of a tab (defaults to the pane's active tab). */
  async readText(paneId: string, tabId: string | null): Promise<string> {
    const tab = this.resolveTab(paneId, tabId)
    if (!tab) throw new Error('no such tab')
    const text = await tab.view.webContents.executeJavaScript(
      'document.body ? document.body.innerText : ""'
    )
    return String(text ?? '')
  }

  /** Click the first element matching a CSS selector. */
  async click(paneId: string, tabId: string | null, selector: string): Promise<void> {
    const tab = this.resolveTab(paneId, tabId)
    if (!tab) throw new Error('no such tab')
    const ok = await tab.view.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false; el.click(); return true; })()`
    )
    if (!ok) throw new Error(`no element matched ${selector}`)
    this.focusHost() // clicking can shift OS focus into the page; hand it back
  }

  /** Focus an input matching a selector and set its value (fires input/change). */
  async type(paneId: string, tabId: string | null, selector: string, text: string): Promise<void> {
    const tab = this.resolveTab(paneId, tabId)
    if (!tab) throw new Error('no such tab')
    const ok = await tab.view.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false; el.focus(); el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
    )
    if (!ok) throw new Error(`no element matched ${selector}`)
    this.focusHost() // el.focus() pulled OS focus into the page; hand it back
  }

  /** PNG screenshot of a tab as a base64 string. */
  async screenshot(paneId: string, tabId: string | null): Promise<string> {
    const tab = this.resolveTab(paneId, tabId)
    if (!tab) throw new Error('no such tab')
    const img = await tab.view.webContents.capturePage()
    return img.toPNG().toString('base64')
  }

  /**
   * Return OS keyboard focus to the host window (the renderer that hosts the
   * terminals) after agent-driven browser activity, and nudge the renderer to
   * re-focus the active terminal — so background browsing never steals the
   * keystrokes you're typing into a session.
   */
  focusHost(): void {
    if (!this.win) return
    this.win.webContents.focus()
    this.win.webContents.send('terminal:refocus')
  }

  // ---- internals ----------------------------------------------------------

  private ensure(paneId: string): PaneBrowser {
    let pb = this.panes.get(paneId)
    if (!pb) this.panes.set(paneId, (pb = { tabs: [], activeTabId: null, bounds: null }))
    return pb
  }

  private resolveTab(paneId: string, tabId: string | null): Tab | undefined {
    const pb = this.panes.get(paneId)
    if (!pb) return undefined
    const id = tabId ?? pb.activeTabId
    return pb.tabs.find((t) => t.id === id)
  }

  private async safeLoad(tab: Tab, url: string): Promise<void> {
    try {
      await tab.view.webContents.loadURL(url)
    } catch {
      /* navigation aborted/failed — did-stop-loading still syncs final state */
    }
  }

  private destroyView(tab: Tab): void {
    try {
      if (this.win) this.win.contentView.removeChildView(tab.view)
      // WebContentsView's contents are torn down when GC'd; close to be prompt.
      ;(tab.view.webContents as unknown as { close?: () => void }).close?.()
    } catch {
      /* already gone */
    }
  }

  /** Show only the foreground pane's active tab, positioned at its bounds; hide all else. */
  private relayout(): void {
    if (!this.win) return
    const fg = this.foreground ? this.panes.get(this.foreground) : null
    for (const [paneId, pb] of this.panes) {
      const isForeground = paneId === this.foreground && !!fg?.bounds
      for (const tab of pb.tabs) {
        const show = isForeground && tab.id === pb.activeTabId
        tab.view.setVisible(show)
        if (show && fg?.bounds) {
          const b = fg.bounds
          tab.view.setBounds({
            x: Math.round(b.x),
            y: Math.round(b.y),
            width: Math.max(0, Math.round(b.width)),
            height: Math.max(0, Math.round(b.height))
          })
        }
      }
    }
  }

  private toPublic(pb: PaneBrowser, t: Tab): BrowserTab {
    return { id: t.id, title: t.title, url: t.url, loading: t.loading, active: pb.activeTabId === t.id }
  }

  private emitTabs(paneId: string): void {
    this.emit('tabs', paneId, this.listTabs(paneId))
  }
}
