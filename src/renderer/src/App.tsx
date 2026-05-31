import { useEffect, useState, useCallback } from 'react'
import type { TerminalSession, HookInstallState } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hooks, setHooks] = useState<HookInstallState | null>(null)

  // Initial load + live updates.
  useEffect(() => {
    window.cockpit.listSessions().then((s) => {
      setSessions(s)
      if (s.length && !activeId) setActiveId(s[0].id)
    })
    const off = window.cockpit.onSessionsChanged(setSessions)
    window.cockpit.hooks.status().then(setHooks)
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep an active selection valid as sessions come and go.
  useEffect(() => {
    if (!sessions.find((s) => s.id === activeId)) {
      setActiveId(sessions[0]?.id ?? null)
    }
  }, [sessions, activeId])

  const createSession = useCallback(async () => {
    const s = await window.cockpit.createSession()
    setActiveId(s.id)
  }, [])

  const closeSession = useCallback((id: string) => window.cockpit.closeSession(id), [])
  const renameSession = useCallback(
    (id: string, name: string) => window.cockpit.renameSession(id, name),
    []
  )

  const installHooks = useCallback(async () => {
    setHooks(await window.cockpit.hooks.install())
  }, [])

  const active = sessions.find((s) => s.id === activeId) ?? null

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={createSession}
        onClose={closeSession}
        onRename={renameSession}
      />
      <main className="stage">
        {hooks && !hooks.installed && (
          <div className="hook-banner">
            <span>
              Status hooks aren’t installed, so live status will stay
              “starting”. Install them into <code>~/.claude/settings.json</code>?
            </span>
            <button onClick={installHooks}>Install status hooks</button>
          </div>
        )}
        <div className="terminals">
          {sessions.length === 0 && (
            <div className="empty">
              <h1>claude-cockpit</h1>
              <p>No sessions yet.</p>
              <button onClick={createSession}>+ New Claude session</button>
            </div>
          )}
          {sessions.map((s) => (
            <TerminalView key={s.id} session={s} active={s.id === activeId} />
          ))}
        </div>
        {active && (
          <footer className="statusbar">
            <span className={`dot ${active.status}`} />
            <strong>{active.name}</strong>
            <span className="muted">{active.status}</span>
            <span className="muted">· {active.lastActivity}</span>
            {active.subagentCount > 0 && (
              <span className="subagents">⛓ {active.subagentCount} sub-agents</span>
            )}
            <span className="spacer" />
            <span className="muted mono">{active.cwd}</span>
          </footer>
        )}
      </main>
    </div>
  )
}
