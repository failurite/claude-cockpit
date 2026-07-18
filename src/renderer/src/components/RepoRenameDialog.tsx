import { useState } from 'react'
import type { Workspace } from '../../../shared/types'

/**
 * Rename a workspace's GitHub repo (via `gh repo rename`). Renames the repo on
 * GitHub and updates the checkout's `origin`; the local folder and the Cockpit
 * workspace name are left as-is (rename those separately).
 */
export function RepoRenameDialog({
  ws,
  onDone,
  onCancel
}: {
  ws: Workspace
  /** Called with the new repo name after a successful rename. */
  onDone: (newName: string) => void
  onCancel: () => void
}): JSX.Element {
  const current = ws.path.split('/').filter(Boolean).pop() || ''
  const [name, setName] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== current && !busy

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const res = await window.cockpit.workspaces.renameRepo(ws.path, trimmed)
    if (!res.ok) {
      setError(res.message || 'Rename failed.')
      setBusy(false)
      return
    }
    onDone(trimmed)
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Rename GitHub repo</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Renames the repo on GitHub and updates this checkout&rsquo;s <code>origin</code>. The
          workspace label follows the new name; the local folder on disk (
          <code>{current}</code>) keeps its path.
        </p>
        <label className="field">
          <span>New repo name</span>
          <input
            className="text-input mono"
            autoFocus
            value={name}
            placeholder="new-name"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
        {error && <div className="dialog-error mono">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  )
}
