import { useState } from 'react'

/** `--model` choices for starting a session; first entry is the default (newest). */
export const MODEL_CHOICES: { value: string; label: string }[] = [
  { value: 'opus', label: 'Opus — newest (default)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'opus[1m]', label: 'Opus · 1M context' },
  { value: 'sonnet[1m]', label: 'Sonnet · 1M context' },
  { value: 'default', label: 'Account default' }
]

/** The default model a new session starts with (the newest). */
export const DEFAULT_MODEL = MODEL_CHOICES[0].value

/**
 * Lightweight "which model?" prompt shown when starting a session (new session or
 * from an issue). Defaults to the newest model; Enter/Start launches.
 */
export function StartSessionDialog({
  title,
  onStart,
  onCancel
}: {
  title: string
  onStart: (model: string) => void
  onCancel: () => void
}): JSX.Element {
  const [model, setModel] = useState(DEFAULT_MODEL)
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        <label className="field">
          <span>Model</span>
          <select
            className="text-input"
            autoFocus
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onStart(model)}
          >
            {MODEL_CHOICES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onStart(model)}>
            Start session
          </button>
        </div>
      </div>
    </div>
  )
}
