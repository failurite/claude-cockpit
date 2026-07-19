import { useState } from 'react'
import type { Workspace } from '../../../shared/types'

/**
 * Rename a workspace's GitHub repo (via `gh repo rename`). Renames the repo on
 * GitHub and updates the checkout's `origin`, and follows the workspace label.
 * Optionally also renames the local folder to match (safe — running sessions keep
 * their cwd via the moved inode; Cockpit re-points the recorded paths).
 */
export function RepoRenameDialog({
  ws,
  onResult,
  onClose
}: {
  ws: Workspace
  /** Apply the updated workspace list (returned on success AND failure). */
  onResult: (workspaces: Workspace[]) => void
  onClose: () => void
}): JSX.Element {
  const current = ws.path.split('/').filter(Boolean).pop() || ''
  const [name, setName] = useState(current)
  const [renameFolder, setRenameFolder] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && trimmed !== current && !busy

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const res = await window.cockpit.workspaces.renameRepo(ws.id, trimmed, renameFolder)
    onResult(res.workspaces) // refresh the sidebar even on partial failure
    if (!res.ok) {
      setError(res.message || 'Rename failed.')
      setBusy(false)
      return
    }
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Rename GitHub repo</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Renames the repo on GitHub and updates this checkout&rsquo;s <code>origin</code>. The
          workspace label follows the new name.
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
        <label className="check">
          <input
            type="checkbox"
            checked={renameFolder}
            disabled={busy}
            onChange={(e) => setRenameFolder(e.target.checked)}
          />
          <span>
            Also rename the local folder{' '}
            <code>
              {current} → {trimmed || 'new-name'}
            </code>
          </span>
        </label>
        {error && <div className="dialog-error mono">{error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
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
