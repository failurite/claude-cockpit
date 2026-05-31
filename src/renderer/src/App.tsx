import { useCallback, useEffect, useState } from 'react'
import type {
  AppInfo,
  HookInstallState,
  TerminalSession,
  Workspace
} from '../../shared/types'
import { DEFAULT_SESSION_OPTIONS } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { LaunchDialog, type LaunchValues } from './components/LaunchDialog'
import { SettingsPanel } from './components/SettingsPanel'

/** Which modal (if any) is open, and the context it needs. */
type Dialog =
  | { kind: 'workspace-new' }
  | { kind: 'workspace-edit'; ws: Workspace }
  | { kind: 'session-custom'; workspaceId: string }

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hooks, setHooks] = useState<HookInstallState | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Initial load + live updates.
  useEffect(() => {
    window.cockpit.listSessions().then((s) => {
      setSessions(s)
      if (s.length && !activeId) setActiveId(s[0].id)
    })
    window.cockpit.workspaces.list().then(setWorkspaces)
    const off = window.cockpit.onSessionsChanged(setSessions)
    window.cockpit.hooks.status().then(setHooks)
    window.cockpit.appInfo().then((info) => {
      setAppInfo(info)
      // Surface the one-time auto-install in Settings rather than a banner.
      if (info.hooksJustInstalled) setSettingsOpen(true)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep an active selection valid as sessions come and go.
  useEffect(() => {
    if (!sessions.find((s) => s.id === activeId)) {
      setActiveId(sessions[0]?.id ?? null)
    }
  }, [sessions, activeId])

  const newSession = useCallback(async (workspaceId: string) => {
    const s = await window.cockpit.createSession({ workspaceId })
    setActiveId(s.id)
  }, [])

  const createDevSession = useCallback(async () => {
    const existing = sessions.find((s) => s.kind === 'dev')
    if (existing) return setActiveId(existing.id)
    const s = await window.cockpit.createDevSession()
    setActiveId(s.id)
  }, [sessions])

  const closeSession = useCallback((id: string) => window.cockpit.closeSession(id), [])
  const renameSession = useCallback(
    (id: string, name: string) => window.cockpit.renameSession(id, name),
    []
  )

  const installHooks = useCallback(async () => {
    setHooks(await window.cockpit.hooks.install())
  }, [])
  const uninstallHooks = useCallback(async () => {
    setHooks(await window.cockpit.hooks.uninstall())
  }, [])

  // Returns an error/status message to show, or null on success.
  const relaunch = useCallback(async (rebuild: boolean): Promise<string | null> => {
    const res = await window.cockpit.relaunchApp({ rebuild })
    return res.ok ? null : res.message ?? 'Relaunch unavailable.'
  }, [])

  const deleteWorkspace = useCallback(async (id: string) => {
    setWorkspaces(await window.cockpit.workspaces.remove(id))
  }, [])

  // --- dialog submit handlers ---
  const submitDialog = useCallback(
    async (v: LaunchValues) => {
      if (!dialog) return
      if (dialog.kind === 'workspace-new') {
        const ws: Workspace = {
          id: crypto.randomUUID(),
          name: v.name || v.path.split('/').filter(Boolean).pop() || v.path,
          path: v.path,
          defaults: v.options
        }
        setWorkspaces(await window.cockpit.workspaces.save(ws))
        const s = await window.cockpit.createSession({ workspaceId: ws.id })
        setActiveId(s.id)
      } else if (dialog.kind === 'workspace-edit') {
        const ws: Workspace = { ...dialog.ws, name: v.name || dialog.ws.name, defaults: v.options }
        setWorkspaces(await window.cockpit.workspaces.save(ws))
      } else if (dialog.kind === 'session-custom') {
        const s = await window.cockpit.createSession({
          workspaceId: dialog.workspaceId,
          name: v.name || undefined,
          options: v.options
        })
        setActiveId(s.id)
      }
      setDialog(null)
    },
    [dialog]
  )

  const active = sessions.find((s) => s.id === activeId) ?? null

  // Resolve initial values for whichever dialog is open.
  const dialogProps = ((): { mode: 'workspace' | 'session'; title: string; submit: string; initial: LaunchValues } | null => {
    if (!dialog) return null
    if (dialog.kind === 'workspace-new')
      return {
        mode: 'workspace',
        title: 'New workspace',
        submit: 'Create workspace',
        initial: { name: '', path: '', options: { ...DEFAULT_SESSION_OPTIONS } }
      }
    if (dialog.kind === 'workspace-edit')
      return {
        mode: 'workspace',
        title: 'Edit workspace',
        submit: 'Save',
        initial: { name: dialog.ws.name, path: dialog.ws.path, options: { ...dialog.ws.defaults } }
      }
    const ws = workspaces.find((w) => w.id === dialog.workspaceId)
    return {
      mode: 'session',
      title: 'New session — custom settings',
      submit: 'Create session',
      initial: { name: '', path: ws?.path ?? '', options: { ...(ws?.defaults ?? DEFAULT_SESSION_OPTIONS) } }
    }
  })()

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        workspaces={workspaces}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={closeSession}
        onRename={renameSession}
        onNewSession={newSession}
        onCustomSession={(workspaceId) => setDialog({ kind: 'session-custom', workspaceId })}
        onNewWorkspace={() => setDialog({ kind: 'workspace-new' })}
        onEditWorkspace={(ws) => setDialog({ kind: 'workspace-edit', ws })}
        onDeleteWorkspace={deleteWorkspace}
        onCreateDev={appInfo?.devAvailable ? createDevSession : undefined}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="stage">
        <div className="terminals">
          {sessions.length === 0 && (
            <div className="empty">
              <h1>claude-cockpit</h1>
              <p>No sessions yet. Create a workspace to get started.</p>
              <div className="empty-actions">
                <button onClick={() => setDialog({ kind: 'workspace-new' })}>+ New workspace</button>
                {appInfo?.devAvailable && (
                  <button className="ghost" onClick={createDevSession}>
                    🛠 Work on this app
                  </button>
                )}
              </div>
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
            {active.kind === 'dev' && <span className="dev-tag">DEV</span>}
            <span className="muted">{active.status}</span>
            <span className="muted">· {active.lastActivity}</span>
            {active.usingChrome && (
              <span className="chrome-badge" title={active.chromeActivity ?? 'driving Chrome'}>
                🌐 Chrome{active.chromeActivity ? ` · ${active.chromeActivity}` : ''}
              </span>
            )}
            {active.subagentCount > 0 && (
              <span className="subagents">⛓ {active.subagentCount} sub-agents</span>
            )}
            <span className="spacer" />
            <span className="muted mono">{active.cwd}</span>
          </footer>
        )}
      </main>

      {dialogProps && (
        <LaunchDialog
          mode={dialogProps.mode}
          title={dialogProps.title}
          submitLabel={dialogProps.submit}
          initial={dialogProps.initial}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          hooks={hooks}
          appInfo={appInfo}
          onInstallHooks={installHooks}
          onUninstallHooks={uninstallHooks}
          onRelaunch={relaunch}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
