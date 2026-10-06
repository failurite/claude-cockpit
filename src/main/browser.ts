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
  /**
   * null = **discarded**: the WebContentsView (a whole Chromium renderer
   * process) has been torn down to reclaim memory, but the tab record — id,
   * title, url — lives on. Any access path recreates it via `ensureView()`, so
   * discarding is invisible apart from a reload. Mirrors Chrome's tab discarding.
   */
  view: WebContentsView | null
  title: string
  url: string
  loading: boolean
  /** ms epoch when this tab was last visible; drives idle discarding. */
  lastShown: number
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
  /**
   * When true, ALL browser views are force-hidden regardless of foreground —
   * used while an app-level modal (e.g. a workspace dialog) is open, since a
   * native WebContentsView always paints over renderer HTML and would otherwise
   * cover the modal.
   */
  private suppressed = false
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
      for (const t of pb.tabs) if (t.view) win.contentView.addChildView(t.view)
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
    const tab: Tab = {
      id: `tab-${++this.seq}`,
      view: null,
      title: url,
      url,
      loading: true,
      lastShown: Date.now(),
      agentLoad: agent
    }
    pb.tabs.push(tab)
    pb.activeTabId = tab.id
    this.attachView(paneId, tab, url)
    this.relayout()
    this.emitTabs(paneId)
    return this.toPublic(pb, tab)
  }

  /**
   * Create (or re-create) a tab's WebContentsView and wire its listeners, then
   * start loading `loadUrl`. Shared by openTab and the un-discard path, so a
   * revived tab behaves exactly like a fresh one.
   */
  private attachView(paneId: string, tab: Tab, loadUrl: string | null): WebContentsView {
    const view = new WebContentsView({ webPreferences: { partition: PARTITION } })
    tab.view = view

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
    // SPA / anchor navigations don't fire did-stop-loading, but they DO change
    // history — re-sync so the back button's enabled state stays accurate.
    wc.on('did-navigate-in-page', () => {
      tab.url = wc.getURL()
      sync()
    })
    // Keep navigations the page initiates (links, redirects) in this same view.
    wc.setWindowOpenHandler(({ url: target }) => {
      void wc.loadURL(target)
      return { action: 'deny' }
    })

    if (this.win) this.win.contentView.addChildView(view)
    if (loadUrl) void this.safeLoad(tab, loadUrl)
    return view
  }

  /**
   * The view for a tab, re-creating it (and reloading its URL) if it was
   * discarded. Every path that needs a live renderer goes through here, so a
   * discarded tab transparently wakes on user *or* agent access.
   */
  private ensureView(paneId: string, tab: Tab): WebContentsView {
    if (tab.view) return tab.view
    const view = this.attachView(paneId, tab, tab.url)
    this.relayout()
    this.emitTabs(paneId)
    return view
  }

  /**
   * Tear down a tab's renderer process but keep the tab (and its URL). This is
   * the main memory lever: each live tab is a full Chromium process, and with 15
   * tabs open the browser family held ~1.95 GB even though only one is ever
   * visible. Never discards the tab the user is currently looking at.
   */
  discardTab(paneId: string, tabId: string): boolean {
    const pb = this.panes.get(paneId)
    const tab = pb?.tabs.find((t) => t.id === tabId)
    if (!pb || !tab || !tab.view) return false
    const isVisible = this.foreground === paneId && pb.activeTabId === tab.id && !this.suppressed
    if (isVisible) return false
    this.destroyView(tab)
    tab.view = null
    tab.loading = false
    this.emitTabs(paneId)
    return true
  }

  /**
   * Discard every tab that hasn't been visible for `idleMs` (and every tab in a
   * pane that isn't the foreground). Returns how many were discarded.
   *
   * Only ONE tab is ever visible in Cockpit, so the rest are pure overhead: they
   * keep running page JS, timers, and websockets (several of ours point at local
   * dev servers with live HMR sockets) for as long as the app is open.
   */
  sweepIdleTabs(idleMs: number): number {
    const now = Date.now()
    let discarded = 0
    for (const [paneId, pb] of this.panes) {
      for (const tab of pb.tabs) {
        if (!tab.view) continue
        const isVisible =
          this.foreground === paneId && pb.activeTabId === tab.id && !this.suppressed
        if (isVisible) {
          tab.lastShown = now
          continue
        }
        if (now - tab.lastShown >= idleMs && this.discardTab(paneId, tab.id)) discarded++
      }
    }
    return discarded
  }

  /** Discard all of a pane's tabs now (used when a session goes to sleep). */
  discardPane(paneId: string): number {
    const pb = this.panes.get(paneId)
    if (!pb) return 0
    let n = 0
    for (const tab of pb.tabs) if (this.discardTab(paneId, tab.id)) n++
    return n
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
    const tab = pb?.tabs.find((t) => t.id === tabId)
    if (pb && tab) {
      pb.activeTabId = tabId
      this.ensureView(paneId, tab) // revive it if it was discarded
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

  /** Step back in a tab's history (no-op at the start of history). */
  goBack(paneId: string, tabId: string | null): void {
    const tab = this.resolveTab(paneId, tabId)
    if (!tab) return
    const wc = this.ensureView(paneId, tab).webContents
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  /** Reload a tab (the loading flag + url sync via the existing wc listeners). */
  reload(paneId: string, tabId: string | null): void {
    const tab = this.resolveTab(paneId, tabId)
    if (tab) this.ensureView(paneId, tab).webContents.reload()
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

  /**
   * Force-hide every browser view (suppressed=true) or resume normal layout
   * (false). Called when an app-level modal opens/closes so the native overlay
   * doesn't paint over it.
   */
  setOverlaySuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return
    this.suppressed = suppressed
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
    const text = await this.ensureView(paneId, tab).webContents.executeJavaScript(
      'document.body ? document.body.innerText : ""'
    )
    return String(text ?? '')
  }

  /** Click the first element matching a CSS selector. */
  async click(paneId: string, tabId: string | null, selector: string): Promise<void> {
    const tab = this.resolveTab(paneId, tabId)
    if (!tab) throw new Error('no such tab')
    const ok = await this.ensureView(paneId, tab).webContents.executeJavaScript(
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
    const ok = await this.ensureView(paneId, tab).webContents.executeJavaScript(
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
    const img = await this.ensureView(paneId, tab).webContents.capturePage()
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
      if (!tab.view) return
      await tab.view.webContents.loadURL(url)
    } catch {
      /* navigation aborted/failed — did-stop-loading still syncs final state */
    }
  }

  private destroyView(tab: Tab): void {
    try {
      if (!tab.view) return
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
      const isForeground = !this.suppressed && paneId === this.foreground && !!fg?.bounds
      for (const tab of pb.tabs) {
        const show = isForeground && tab.id === pb.activeTabId
        if (!tab.view) continue
        if (show) tab.lastShown = Date.now()
        tab.view.setVisible(show)
        if (show && fg?.bounds) {
          // The renderer measures in CSS px, but a WebContentsView is placed in
          // window DIPs — they differ by the window's page zoom (⌘− / ⌘=), which
          // otherwise shrinks/shifts the view off the panel. Applied here so it's
          // always the current zoom (a zoom change also fires the renderer's
          // `resize`, which re-reports bounds and lands back here).
          const z = this.win.webContents.getZoomFactor()
          const b = fg.bounds
          tab.view.setBounds({
            x: Math.round(b.x * z),
            y: Math.round(b.y * z),
            width: Math.max(0, Math.round(b.width * z)),
            height: Math.max(0, Math.round(b.height * z))
          })
        }
      }
    }
  }

  private toPublic(pb: PaneBrowser, t: Tab): BrowserTab {
    let canGoBack = false
    try {
      canGoBack = !!t.view && t.view.webContents.navigationHistory.canGoBack()
    } catch {
      /* view destroyed mid-teardown */
    }
    return {
      id: t.id,
      title: t.title,
      url: t.url,
      loading: t.loading,
      active: pb.activeTabId === t.id,
      canGoBack,
      discarded: !t.view
    }
  }

  private emitTabs(paneId: string): void {
    this.emit('tabs', paneId, this.listTabs(paneId))
  }
}
