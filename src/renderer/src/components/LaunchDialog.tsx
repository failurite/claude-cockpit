import { useState } from 'react'
import type { SessionOptions } from '../../../shared/types'

export interface LaunchValues {
  name: string
  /** Only meaningful in 'workspace' mode. */
  path: string
  options: SessionOptions
}

interface Props {
  /** 'workspace' shows the folder picker + name; 'session' shows options only. */
  mode: 'workspace' | 'session'
  title: string
  submitLabel: string
  initial: LaunchValues
  onSubmit: (v: LaunchValues) => void
  onCancel: () => void
}

/** Preview of the exact command a session will launch with. */
function previewCommand(o: SessionOptions): string {
  const parts = ['claude']
  if (o.dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions')
  if (o.chrome) parts.push('--chrome')
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
  const [options, setOptions] = useState<SessionOptions>(initial.options)

  const set = <K extends keyof SessionOptions>(key: K, value: SessionOptions[K]): void =>
    setOptions((o) => ({ ...o, [key]: value }))

  const browse = async (): Promise<void> => {
    const dir = await window.cockpit.pickFolder()
    if (dir) {
      setPath(dir)
      if (!name.trim()) setName(dir.split('/').filter(Boolean).pop() || dir)
    }
  }

  const canSubmit = mode === 'session' || path.trim().length > 0
  const submit = (): void => {
    if (!canSubmit) return
    onSubmit({ name: name.trim(), path: path.trim(), options })
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>

        {mode === 'workspace' && (
          <label className="field">
            <span>Folder</span>
            <div className="field-row">
              <input
                className="text-input mono"
                value={path}
                placeholder="/path/to/project"
                onChange={(e) => setPath(e.target.value)}
              />
              <button className="btn" onClick={browse}>
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
            <span>
              Drive Chrome <code>--chrome</code>
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

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
