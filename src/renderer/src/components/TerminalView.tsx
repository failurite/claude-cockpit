import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalSession } from '../../../shared/types'

interface Props {
  session: TerminalSession
  active: boolean
}

/**
 * One live xterm.js view bound to a pty in the main process. Stays mounted when
 * inactive (hidden via CSS) so scrollback and the live process persist.
 */
export function TerminalView({ session, active }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  const refit = (): void => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    try {
      fit.fit()
      window.cockpit.resize(session.id, term.cols, term.rows)
    } catch {
      /* container not measurable (hidden) */
    }
  }

  // Create the terminal once per pane.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      theme: { background: '#14161b', foreground: '#e6e6e6' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    termRef.current = term
    fitRef.current = fit

    const id = session.id
    const input = term.onData((data) => window.cockpit.write(id, data))
    const off = window.cockpit.onData(id, (data) => term.write(data))
    window.cockpit.attach(id).then((buf) => {
      if (buf) term.write(buf)
      refit()
    })

    const ro = new ResizeObserver(() => {
      if (activeRef.current) refit()
    })
    ro.observe(hostRef.current!)

    return () => {
      input.dispose()
      off()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // Refit + focus when this pane becomes the visible one.
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      refit()
      termRef.current?.focus()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  return <div ref={hostRef} className={`term-host ${active ? 'active' : 'hidden'}`} />
}
