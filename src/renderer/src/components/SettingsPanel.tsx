import { useEffect, useState } from 'react'
import type {
  AppInfo,
  AppSettings,
  GatewayInfo,
  HookInstallState,
  UpdateStatus
} from '../../../shared/types'

/** One-line summary of the current update status for the Settings UI. */
function updateLabel(s: UpdateStatus): string {
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Update ${s.version ?? ''} found — downloading…`
    case 'downloading':
      return `Downloading… ${s.percent ?? 0}%`
    case 'downloaded':
      return `Update ${s.version ?? ''} ready — restart to install.`
    case 'not-available':
      return 'You’re on the latest version.'
    case 'error':
      return `Update error: ${s.message ?? 'unknown'}`
    case 'unsupported':
      return s.message ?? 'Auto-update is unavailable in this build.'
    default:
      return ''
  }
}

interface Props {
  hooks: HookInstallState | null
  appInfo: AppInfo | null
  onInstallHooks: () => void
  onUninstallHooks: () => void
  onRelaunch: (rebuild: boolean) => Promise<string | null>
  /** Re-fetch the workspace list (e.g. after toggling the Cockpit workspace). */
  onRefreshWorkspaces: () => void
  onClose: () => void
}

/** Settings modal: status hooks, tmux session cleanup, and rebuild/relaunch. */
export function SettingsPanel({
  hooks,
  appInfo,
  onInstallHooks,
  onUninstallHooks,
  onRelaunch,
  onRefreshWorkspaces,
  onClose
}: Props): JSX.Element {
  const [relaunchMsg, setRelaunchMsg] = useState<string | null>(null)
  const [tmuxAvailable, setTmuxAvailable] = useState<boolean | null>(null)
  const [tmuxSessions, setTmuxSessions] = useState<string[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [gwInfo, setGwInfo] = useState<GatewayInfo | null>(null)

  useEffect(() => {
    window.cockpit.tmux.available().then(setTmuxAvailable)
    window.cockpit.tmux.list().then(setTmuxSessions)
    window.cockpit.settings.get().then(setSettings)
    window.cockpit.updates.status().then(setUpdate)
    window.cockpit.gateway.info().then(setGwInfo)
    return window.cockpit.updates.onStatus(setUpdate)
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
  const checkForUpdates = async (): Promise<void> => {
    setUpdate(await window.cockpit.updates.check())
  }
  const closeAllSessions = async (): Promise<void> => {
    if (!window.confirm('Close ALL sessions and kill cockpit tmux sessions? This cannot be undone.'))
      return
    setTmuxSessions(await window.cockpit.closeAllSessions())
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
          <span>Sessions</span>
          <p className="settings-note">
            Close every session at once and sweep any lingering cockpit-owned tmux sessions — a
            clean slate with nothing left running in the background.
          </p>
          <button className="btn danger" onClick={closeAllSessions}>
            Close all sessions
          </button>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={!!settings?.hideCockpitWorkspace}
              onChange={async (e) => {
                setSettings(await window.cockpit.settings.update({ hideCockpitWorkspace: e.target.checked }))
                onRefreshWorkspaces()
              }}
            />
            Hide the Cockpit workspace (this app’s own repo)
          </label>
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
                Cockpit sessions run inside persistent tmux sessions so they survive app restarts
                (the process keeps running; Cockpit re-attaches). These are cockpit-owned and listed
                here so none go rogue.
              </p>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={settings ? settings.keepSessionsAlive : true}
                  onChange={async (e) =>
                    setSettings(
                      await window.cockpit.settings.update({ keepSessionsAlive: e.target.checked })
                    )
                  }
                />
                Keep sessions alive across app restarts (tmux) — the Dev session always persists
              </label>
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
              v{appInfo.version} · {appInfo.isDev ? 'dev' : 'packaged'} · {appInfo.repoRoot}
            </p>
          )}
        </div>

        <div className="field">
          <span>Updates</span>
          <p className="settings-note">
            Cockpit auto-updates from GitHub Releases in the background. Updates apply on the next
            launch, or restart now when one is ready. (Requires a signed, packaged build.)
          </p>
          <div className="field-row">
            <button
              className="btn"
              onClick={checkForUpdates}
              disabled={update?.state === 'unsupported' || update?.state === 'checking'}
            >
              Check for updates
            </button>
            {update?.state === 'downloaded' && (
              <button className="btn primary" onClick={() => window.cockpit.updates.install()}>
                Restart &amp; install
              </button>
            )}
          </div>
          {update && updateLabel(update) && (
            <p className="settings-note">{updateLabel(update)}</p>
          )}
        </div>

        <div className="field">
          <span>Phone access</span>
          <p className="settings-note">
            Open this URL on a phone/tablet on the same Wi-Fi for a live, read-only view of your
            sessions. The token in the link is your password — anyone with it can see your sessions,
            so don’t share it.
          </p>
          {gwInfo?.ip ? (
            <>
              <p className="settings-note mono" style={{ wordBreak: 'break-all' }}>
                {gwInfo.url}
              </p>
              <div className="field-row">
                <button className="btn" onClick={() => navigator.clipboard?.writeText(gwInfo.url)}>
                  Copy link
                </button>
              </div>
            </>
          ) : (
            <p className="settings-note mono">
              {gwInfo ? 'No LAN address detected (are you on Wi-Fi?).' : 'Gateway not running.'}
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
