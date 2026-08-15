import { useState } from 'react'

/**
 * `--model` choices for starting a session; first entry is the default.
 *
 * We offer the 1M-context variants only (no reason to run less on these models).
 * Opus is pinned to the explicit `claude-opus-5[1m]` id on purpose: the bare
 * `opus` alias on the installed CLI still resolves to Opus 4.8, so the alias
 * can't be trusted to give the newest Opus — update this id when a newer Opus
 * ships (or once the `opus` alias tracks it). Sonnet/Haiku stay on aliases.
 */
export const MODEL_CHOICES: { value: string; label: string }[] = [
  { value: 'claude-opus-5[1m]', label: 'Opus 5 · 1M context (default)' },
  { value: 'sonnet[1m]', label: 'Sonnet · 1M context' },
  { value: 'haiku', label: 'Haiku' },
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
