import { useEffect, useRef, useState } from 'react'
import type { RepoLabel } from '../../../shared/types'

/** Read a File as base64 (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/**
 * Create a GitHub issue for a workspace: title, markdown description (paste images
 * — they upload to GitHub and insert as markdown links), and repo labels as
 * checkboxes. Uses the gh CLI under the hood.
 */
export function NewIssueDialog({
  workspacePath,
  onCreated,
  onCancel
}: {
  workspacePath: string
  /** Called with the new issue URL after a successful create. */
  onCreated: (url?: string) => void
  onCancel: () => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [labels, setLabels] = useState<RepoLabel[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    window.cockpit.issues.labels(workspacePath).then(setLabels)
  }, [workspacePath])

  const insertAtCursor = (text: string): void => {
    const ta = bodyRef.current
    const at = ta ? ta.selectionStart : body.length
    setBody((prev) => prev.slice(0, at) + text + prev.slice(at))
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const imgs = [...(e.clipboardData?.items ?? [])].filter(
      (it) => it.kind === 'file' && it.type.startsWith('image/')
    )
    if (imgs.length === 0) return // let normal text paste through
    e.preventDefault()
    for (const it of imgs) {
      const file = it.getAsFile()
      if (!file) continue
      setUploading((n) => n + 1)
      try {
        const dataBase64 = await fileToBase64(file)
        const res = await window.cockpit.issues.uploadImage(workspacePath, {
          name: file.name || 'image.png',
          contentType: file.type || 'image/png',
          dataBase64
        })
        if (res.ok && res.url) insertAtCursor(`\n![${file.name || 'image'}](${res.url})\n`)
        else setError(res.message || 'Image upload failed.')
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const toggleLabel = (name: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })

  const canSubmit = title.trim().length > 0 && uploading === 0 && !busy
  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const res = await window.cockpit.issues.create(workspacePath, {
      title: title.trim(),
      body,
      labels: [...selected]
    })
    if (!res.ok) {
      setError(res.message || 'Failed to create the issue.')
      setBusy(false)
      return
    }
    onCreated(res.url)
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">New GitHub issue</h2>

        <label className="field">
          <span>Title</span>
          <input
            className="text-input"
            autoFocus
            value={title}
            placeholder="Short summary"
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="field">
          <span>
            Description <span className="muted-label">(markdown — paste images to attach)</span>
          </span>
          <textarea
            ref={bodyRef}
            className="text-input issue-body"
            value={body}
            placeholder="Describe the issue… paste a screenshot to upload it inline."
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
            onPaste={onPaste}
          />
          {uploading > 0 && <span className="muted-label">Uploading image…</span>}
        </label>

        <div className="field">
          <span>Labels</span>
          {labels.length === 0 ? (
            <span className="muted-label">No labels on this repo.</span>
          ) : (
            <div className="issue-labels">
              {labels.map((l) => (
                <label key={l.name} className="issue-label-check" title={l.description}>
                  <input
                    type="checkbox"
                    checked={selected.has(l.name)}
                    disabled={busy}
                    onChange={() => toggleLabel(l.name)}
                  />
                  <span
                    className="issue-label-swatch"
                    style={{ background: l.color ? `#${l.color}` : 'var(--border)' }}
                  />
                  <span>{l.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <div className="dialog-error mono">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Creating…' : 'Create issue'}
          </button>
        </div>
      </div>
    </div>
  )
}
