import { useState } from 'react'
import type { SessionOptions } from '../../../shared/types'

/** How a new workspace's folder is sourced. */
export type WorkspaceSource = 'folder' | 'clone' | 'new'

export interface LaunchValues {
  name: string
  /** Only meaningful in 'workspace' mode. Folder / clone destination / new-repo parent. */
  path: string
  options: SessionOptions
  /** Workspace mode: how the workspace is created (default 'folder'). */
  source?: WorkspaceSource
  /** source==='clone': a GitHub repo URL (or owner/repo) to clone into `path`. */
  repoUrl?: string
  /** source==='new': create this repo under the account, clone into `path`/<name>. */
  newRepo?: { name: string; private: boolean; description: string }
}

interface Props {
  /** 'workspace' shows the folder picker + name; 'session' shows options only. */
  mode: 'workspace' | 'session'
  title: string
  submitLabel: string
  initial: LaunchValues
  /** Show the Folder/Clone/New-repo source selector (only when creating a workspace). */
  allowGithubSource?: boolean
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
  allowGithubSource,
  onSubmit,
  onCancel
}: Props): JSX.Element {
  const [name, setName] = useState(initial.name)
  const [path, setPath] = useState(initial.path)
  const [source, setSource] = useState<WorkspaceSource>(initial.source ?? 'folder')
  const [repoUrl, setRepoUrl] = useState(initial.repoUrl ?? '')
  const [newName, setNewName] = useState(initial.newRepo?.name ?? '')
  const [isPrivate, setIsPrivate] = useState(initial.newRepo?.private ?? true)
  const [desc, setDesc] = useState(initial.newRepo?.description ?? '')
  const [options, setOptions] = useState<SessionOptions>(initial.options)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track values we auto-filled (from the repo URL / new-repo name) so we only
  // overwrite our own suggestion — never something the user typed.
  const [autoPath, setAutoPath] = useState(initial.path)
  const [autoName, setAutoName] = useState(initial.name)

  const set = <K extends keyof SessionOptions>(key: K, value: SessionOptions[K]): void =>
    setOptions((o) => ({ ...o, [key]: value }))

  const browse = async (): Promise<void> => {
    const dir = await window.cockpit.pickFolder()
    if (dir) {
      setPath(dir)
      if (!name.trim()) setName(dir.split('/').filter(Boolean).pop() || dir)
    }
  }

  // Prefill the destination folder + names from the repo (clone URL or new name),
  // unless the user has already customised them.
  const suggestFrom = (repo: string): void => {
    if (!repo) return
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
  const onRepoUrl = (raw: string): void => {
    setRepoUrl(raw)
    suggestFrom(repoName(raw))
  }
  const onNewName = (raw: string): void => {
    setNewName(raw)
    // For a new repo the folder is <parent>/<name>, so only the workspace name
    // tracks the repo name (path stays the parent).
    if (name === autoName) {
      setName(raw)
      setAutoName(raw)
    }
  }

  const cloning = mode === 'workspace' && allowGithubSource && source === 'clone'
  const creating = mode === 'workspace' && allowGithubSource && source === 'new'

  const canSubmit =
    mode === 'session' ||
    (cloning
      ? repoUrl.trim().length > 0
      : creating
        ? newName.trim().length > 0
        : path.trim().length > 0 || name.trim().length > 0)

  const submit = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    const values: LaunchValues = {
      name: name.trim(),
      path: path.trim(),
      options,
      source,
      repoUrl: cloning ? repoUrl.trim() : undefined,
      newRepo: creating
        ? { name: newName.trim(), private: isPrivate, description: desc.trim() }
        : undefined
    }
    const err = await onSubmit(values)
    if (err) {
      setError(err)
      setBusy(false)
    }
    // On success the parent unmounts this dialog.
  }

  const submitText = busy
    ? cloning
      ? 'Cloning…'
      : creating
        ? 'Creating…'
        : 'Working…'
    : cloning
      ? 'Clone & create'
      : creating
        ? 'Create repo & workspace'
        : submitLabel

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>

        {mode === 'workspace' && allowGithubSource && (
          <div className="field">
            <span>Create from</span>
            <div className="seg">
              {(
                [
                  ['folder', 'Folder'],
                  ['clone', 'Clone repo'],
                  ['new', 'New GitHub repo']
                ] as [WorkspaceSource, string][]
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={source === v ? 'on' : ''}
                  disabled={busy}
                  onClick={() => setSource(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {cloning && (
          <label className="field">
            <span>GitHub repo</span>
            <input
              className="text-input mono"
              value={repoUrl}
              placeholder="https://github.com/owner/repo — or owner/repo"
              disabled={busy}
              onChange={(e) => onRepoUrl(e.target.value)}
            />
          </label>
        )}

        {creating && (
          <>
            <label className="field">
              <span>New repo name</span>
              <input
                className="text-input mono"
                value={newName}
                placeholder="my-project"
                disabled={busy}
                onChange={(e) => onNewName(e.target.value)}
              />
            </label>
            <div className="field">
              <span>Visibility</span>
              <div className="seg">
                <button className={isPrivate ? 'on' : ''} disabled={busy} onClick={() => setIsPrivate(true)}>
                  🔒 Private
                </button>
                <button className={!isPrivate ? 'on' : ''} disabled={busy} onClick={() => setIsPrivate(false)}>
                  🌐 Public
                </button>
              </div>
            </div>
            <label className="field">
              <span className="muted-label">Description (optional)</span>
              <input
                className="text-input"
                value={desc}
                placeholder="What is this project?"
                disabled={busy}
                onChange={(e) => setDesc(e.target.value)}
              />
            </label>
          </>
        )}

        {mode === 'workspace' && (
          <label className="field">
            <span>
              {cloning ? 'Clone into (new folder)' : creating ? 'Create in (parent folder)' : 'Folder (optional)'}
            </span>
            <div className="field-row">
              <input
                className="text-input mono"
                value={path}
                placeholder={
                  cloning
                    ? '~/repo — where to clone it'
                    : creating
                      ? '~ — the new folder goes here'
                      : '/path/to/project — leave blank to set up later'
                }
                disabled={busy}
                onChange={(e) => setPath(e.target.value)}
              />
              <button className="btn" onClick={browse} disabled={busy}>
                Browse…
              </button>
            </div>
            {creating && newName.trim() && (
              <span className="muted-label mono">
                → creates {(path.trim() || '~').replace(/\/$/, '')}/{newName.trim()}
              </span>
            )}
          </label>
        )}

        <label className="field">
          <span>{mode === 'workspace' ? 'Workspace name' : 'Session name (optional)'}</span>
          <input
            className="text-input"
            value={name}
            placeholder={mode === 'workspace' ? 'My project' : 'Session'}
            disabled={busy}
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
            {submitText}
          </button>
        </div>
      </div>
    </div>
  )
}
