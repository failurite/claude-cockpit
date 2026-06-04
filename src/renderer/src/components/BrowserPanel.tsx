import { useEffect, useRef, useState } from 'react'
import type { BrowserTab } from '../../../shared/types'

interface Props {
  /** The pane whose embedded browser this panel shows. */
  paneId: string
  /** Hide/close the panel (the tabs themselves persist in main). */
  onClose: () => void
}

/**
 * Chrome for a session's embedded browser. The web content itself is a native
 * WebContentsView positioned by the main process over the `.browser-stage`
 * rectangle we reserve here — so this component only renders the tab strip, URL
 * bar, and the placeholder whose on-screen bounds we report to main.
 */
export function BrowserPanel({ paneId, onClose }: Props): JSX.Element {
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [urlDraft, setUrlDraft] = useState('')
  const stageRef = useRef<HTMLDivElement>(null)

  // Panel width, user-resizable via the left-edge handle; persisted.
  const [width, setWidth] = useState(() => {
    const w = Number(localStorage.getItem('browserPanelWidth'))
    return w >= 300 && w <= 1600 ? w : 520
  })
  useEffect(() => localStorage.setItem('browserPanelWidth', String(width)), [width])
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    // The WebContentsView is a NATIVE overlay — it would swallow mouse events
    // mid-drag, so hide it while resizing and restore on release.
    window.cockpit.browser.setVisible(paneId, false)
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent): void =>
      setWidth(
        Math.min(Math.max(300, window.innerWidth - 420), Math.max(300, startW - (ev.clientX - startX)))
      )
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('dragging-h')
      window.cockpit.browser.setVisible(paneId, true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.classList.add('dragging-h')
  }

  const active = tabs.find((t) => t.active) ?? null

  // Load tabs + subscribe to live changes for this pane.
  useEffect(() => {
    window.cockpit.browser.listTabs(paneId).then(setTabs)
    const off = window.cockpit.browser.onTabsChanged((id, next) => {
      if (id === paneId) setTabs(next)
    })
    return off
  }, [paneId])

  // Keep the URL bar in sync with the active tab (unless the user is editing).
  useEffect(() => {
    setUrlDraft(active?.url ?? '')
  }, [active?.id, active?.url])

  // Tell main where to render the active tab, and show it; hide on unmount.
  useEffect(() => {
    window.cockpit.browser.setVisible(paneId, true)
    const report = (): void => {
      const el = stageRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      // 6px left inset keeps the resize handle renderer-owned (the native view
      // would otherwise sit on top of it and eat the mousedown).
      window.cockpit.browser.setBounds(paneId, {
        x: r.left + 6,
        y: r.top,
        width: Math.max(0, r.width - 6),
        height: r.height
      })
    }
    report()
    const ro = new ResizeObserver(report)
    if (stageRef.current) ro.observe(stageRef.current)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      window.cockpit.browser.setBounds(paneId, null)
      window.cockpit.browser.setVisible(paneId, false)
    }
  }, [paneId])

  const go = (): void => {
    const url = normalizeUrl(urlDraft)
    if (!url) return
    if (active) window.cockpit.browser.navigate(paneId, active.id, url)
    else window.cockpit.browser.openTab(paneId, url)
  }

  return (
    <div className="browser-panel" style={{ width, minWidth: 300 }}>
      <div className="v-resizer browser-edge" onMouseDown={startResize} title="Drag to resize" />
      <div className="browser-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`browser-tab ${t.active ? 'active' : ''}`}
            onClick={() => window.cockpit.browser.activateTab(paneId, t.id)}
            title={t.url}
          >
            <span className="browser-tab-title">{t.loading ? '…' : t.title || t.url}</span>
            <button
              className="browser-tab-close"
              onClick={(e) => {
                e.stopPropagation()
                window.cockpit.browser.closeTab(paneId, t.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="browser-newtab" onClick={() => window.cockpit.browser.openTab(paneId)}>
          +
        </button>
        <span className="spacer" />
        <button className="browser-hide" onClick={onClose} title="Hide browser">
          ⤬
        </button>
      </div>

      <div className="browser-urlbar">
        <input
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder="Enter a URL…"
          spellCheck={false}
        />
        <button onClick={go}>Go</button>
      </div>

      <div ref={stageRef} className="browser-stage">
        {tabs.length === 0 && (
          <div className="browser-empty">
            No tabs yet. The agent can open one with <code>browser_open_tab</code>, or click +.
          </div>
        )}
      </div>
    </div>
  )
}

/** Add https:// when the user typed a bare host; pass through anything with a scheme. */
function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^[a-z]+:\/\//i.test(s) || s.startsWith('about:')) return s
  return `https://${s}`
}
