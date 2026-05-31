import { useEffect, useState } from 'react'
import type { AppInfo, AppSettings, HookInstallState } from '../../../shared/types'

interface Props {
  hooks: HookInstallState | null
  appInfo: AppInfo | null
  onInstallHooks: () => void
  onUninstallHooks: () => void
  onRelaunch: (rebuild: boolean) => Promise<string | null>
  onClose: () => void
}

/** Settings modal: status hooks, tmux session cleanup, and rebuild/relaunch. */
export function SettingsPanel({
  hooks,
  appInfo,
  onInstallHooks,
  onUninstallHooks,
  onRelaunch,
  onClose
}: Props): JSX.Element {
  const [relaunchMsg, setRelaunchMsg] = useState<string | null>(null)
  const [tmuxAvailable, setTmuxAvailable] = useState<boolean | null>(null)
  const [tmuxSessions, setTmuxSessions] = useState<string[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    window.cockpit.tmux.available().then(setTmuxAvailable)
    window.cockpit.tmux.list().then(setTmuxSessions)
    window.cockpit.settings.get().then(setSettings)
  }, [])

  const relaunch = async (rebuild: boolean): Promise<void> => {
    setRelaunchMsg(rebuild ? 'Rebuilding…' : 'Relaunching…')
    setRelaunchMsg(await onRelaunch(rebuild))
  }

  const killTmux = async (name: string): Promise<void> => {
    setTmuxSessions(await window.cockpit.tmux.kill(name))
  }
  const toggleKillOnQuit = async (value: boolean): Promise<void> => {
    setSettings(await window.cockpit.settings.update({ killTmuxOnQuit: value }))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Settings</h2>

        <div className="field">
          <span>Status hooks</span>
          <p className="settings-note">
            Cockpit reads live session status from Claude Code hooks in{' '}
            <code>~/.claude/settings.json</code> (a backup is saved first). Without them, sessions
            stay on “starting”. You can remove them anytime.
          </p>
          {hooks?.installed ? (
            <div className="field-row">
              <span className="ok-tag">✓ Installed</span>
              <button className="btn" onClick={onUninstallHooks}>
                Uninstall
              </button>
            </div>
          ) : (
            <button className="btn primary" onClick={onInstallHooks}>
              Install status hooks
            </button>
          )}
        </div>

        <div className="field">
          <span>tmux sessions</span>
          {tmuxAvailable === false ? (
            <p className="settings-note">
              tmux isn’t installed, so the dev session falls back to{' '}
              <code>claude --resume</code> (conversation persists, process restarts). Install tmux
              (<code>brew install tmux</code>) for full process persistence.
            </p>
          ) : (
            <>
              <p className="settings-note">
                The Cockpit Dev session runs inside a persistent tmux session so it survives app
                restarts. These are cockpit-owned and listed here so none go rogue.
              </p>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={!!settings?.killTmuxOnQuit}
                  onChange={(e) => toggleKillOnQuit(e.target.checked)}
                />
                Kill cockpit tmux sessions when I quit the app
              </label>
              {tmuxSessions.length === 0 ? (
                <p className="settings-note mono">No active cockpit tmux sessions.</p>
              ) : (
                <ul className="tmux-list">
                  {tmuxSessions.map((name) => (
                    <li key={name}>
                      <span className="mono">{name}</span>
                      <button className="btn danger" onClick={() => killTmux(name)}>
                        Kill
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="field">
          <span>App</span>
          <div className="field-row">
            <button className="btn" onClick={() => relaunch(true)}>
              ⟳ Rebuild &amp; relaunch
            </button>
            <button className="btn" onClick={() => relaunch(false)}>
              Relaunch
            </button>
          </div>
          {relaunchMsg && <p className="settings-note">{relaunchMsg}</p>}
          {appInfo && (
            <p className="settings-note mono">
              {appInfo.isDev ? 'dev' : 'packaged'} · {appInfo.repoRoot}
            </p>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
