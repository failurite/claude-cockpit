import { useState } from 'react'
import type { SessionOptions } from '../../../shared/types'

export interface LaunchValues {
  name: string
  /** Only meaningful in 'workspace' mode. */
  path: string
  options: SessionOptions
  /** Workspace mode only: a GitHub repo to clone into `path` when creating. */
  repoUrl?: string
}

interface Props {
  /** 'workspace' shows the folder picker + name; 'session' shows options only. */
  mode: 'workspace' | 'session'
  title: string
  submitLabel: string
  initial: LaunchValues
  /** Do the work; resolve with an error string to keep the dialog open, or null on success. */
  onSubmit: (v: LaunchValues) => Promise<string | null>
  onCancel: () => void
}

/** The folder name a clone URL produces: `.../foo.git` or `owner/foo` → `foo`. */
function repoName(url: string): string {
  const m = url.trim().replace(/\/+$/, '').match(/([^/]+?)(\.git)?$/)
  return (m && m[1]) || ''
}

/** Preview of the exact command a session will launch with. */
function previewCommand(o: SessionOptions): string {
  const parts = ['claude']
  if (o.dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions')
  if (o.chrome && o.externalChrome) parts.push('--chrome')
  else parts.push(...(o.chrome ? ['--no-chrome', '--mcp-config <cockpit-browser>'] : ['--no-chrome']))
  if (o.extraArgs.trim()) parts.push(o.extraArgs.trim())
  return parts.join(' ')
}

/** Modal for defining a workspace or a custom-settings session. */
export function LaunchDialog({
  mode,
  title,
  submitLabel,
  initial,
  onSubmit,
  onCancel
}: Props): JSX.Element {
  const [name, setName] = useState(initial.name)
  const [path, setPath] = useState(initial.path)
  const [repoUrl, setRepoUrl] = useState(initial.repoUrl ?? '')
  const [options, setOptions] = useState<SessionOptions>(initial.options)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track values we auto-filled from the repo URL, so we only overwrite our own
  // suggestion — never something the user typed.
  const [autoPath, setAutoPath] = useState(initial.path)
  const [autoName, setAutoName] = useState(initial.name)

  const cloning = mode === 'workspace' && repoUrl.trim().length > 0

  const set = <K extends keyof SessionOptions>(key: K, value: SessionOptions[K]): void =>
    setOptions((o) => ({ ...o, [key]: value }))

  const browse = async (): Promise<void> => {
    const dir = await window.cockpit.pickFolder()
    if (dir) {
      setPath(dir)
      if (!name.trim()) setName(dir.split('/').filter(Boolean).pop() || dir)
    }
  }

  // Typing a repo URL prefills the destination folder (~/<repo>) and name, unless
  // the user has already customised them.
  const onRepoUrl = (raw: string): void => {
    setRepoUrl(raw)
    const repo = repoName(raw)
    if (repo) {
      const suggestedPath = `~/${repo}`
      if (path === autoPath) {
        setPath(suggestedPath)
        setAutoPath(suggestedPath)
      }
      if (name === autoName) {
        setName(repo)
        setAutoName(repo)
      }
    }
  }

  // A session inherits its workspace; a workspace needs a repo, a name, OR a
  // folder to identify it — but you can create one before you have any of them
  // (sessions fall back to your home directory until you set a folder).
  const canSubmit =
    mode === 'session' || cloning || path.trim().length > 0 || name.trim().length > 0
  const submit = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    const err = await onSubmit({
      name: name.trim(),
      path: path.trim(),
      options,
      repoUrl: cloning ? repoUrl.trim() : undefined
    })
    if (err) {
      setError(err)
      setBusy(false)
    }
    // On success the parent unmounts this dialog.
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>

        {mode === 'workspace' && (
          <label className="field">
            <span>GitHub repo (optional)</span>
            <input
              className="text-input mono"
              value={repoUrl}
              placeholder="https://github.com/owner/repo — or owner/repo"
              disabled={busy}
              onChange={(e) => onRepoUrl(e.target.value)}
            />
          </label>
        )}

        {mode === 'workspace' && (
          <label className="field">
            <span>{cloning ? 'Clone into (new folder)' : 'Folder (optional)'}</span>
            <div className="field-row">
              <input
                className="text-input mono"
                value={path}
                placeholder={
                  cloning
                    ? '~/repo — where to clone it'
                    : '/path/to/project — leave blank to set up later'
                }
                disabled={busy}
                onChange={(e) => setPath(e.target.value)}
              />
              <button className="btn" onClick={browse} disabled={busy}>
                Browse…
              </button>
            </div>
          </label>
        )}

        <label className="field">
          <span>{mode === 'workspace' ? 'Workspace name' : 'Session name (optional)'}</span>
          <input
            className="text-input"
            value={name}
            placeholder={mode === 'workspace' ? 'My project' : 'Session'}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="field">
          <span>{mode === 'workspace' ? 'Default launch options' : 'Launch options'}</span>
          <label className="check">
            <input
              type="checkbox"
              checked={options.dangerouslySkipPermissions}
              onChange={(e) => set('dangerouslySkipPermissions', e.target.checked)}
            />
            <span>
              Skip permissions <code>--dangerously-skip-permissions</code>
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={options.chrome}
              onChange={(e) => set('chrome', e.target.checked)}
            />
            <span>Enable browser (embedded, in-Cockpit)</span>
          </label>
          <label className="check" style={{ marginLeft: 22, opacity: options.chrome ? 1 : 0.4 }}>
            <input
              type="checkbox"
              disabled={!options.chrome}
              checked={options.externalChrome}
              onChange={(e) => set('externalChrome', e.target.checked)}
            />
            <span>
              Use external Chrome instead <code>--chrome</code>
            </span>
          </label>
          <label className="field" style={{ marginTop: 8 }}>
            <span className="muted-label">Extra args</span>
            <input
              className="text-input mono"
              value={options.extraArgs}
              placeholder="--model opus"
              onChange={(e) => set('extraArgs', e.target.value)}
            />
          </label>
        </div>

        <div className="cmd-preview mono">{previewCommand(options)}</div>

        {error && <div className="dialog-error mono">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canSubmit || busy} onClick={submit}>
            {busy ? (cloning ? 'Cloning…' : 'Working…') : cloning ? 'Clone & create' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
