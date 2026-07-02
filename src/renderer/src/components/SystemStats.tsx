import { useEffect, useState } from 'react'
import type { SystemStats as Stats } from '../../../shared/types'
import { CLAUDE_USAGE_URL } from '../../../shared/types'

/** tokens/sec that fills the token meter — a soft full-scale, not a real quota. */
const TOKEN_RATE_FULL_SCALE = 3000

/** Compact tokens (1234 → "1.2k", 1_200_000 → "1.2M"). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function fmtGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}`
}

/** One labelled meter: a thin fill bar + a numeric readout. */
function Meter({
  label,
  percent,
  value,
  tone,
  title
}: {
  label: string
  percent: number
  value: string
  tone: 'cpu' | 'mem' | 'tok'
  title?: string
}): JSX.Element {
  return (
    <div className="meter" title={title}>
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        <span
          className={`meter-fill ${tone}`}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </span>
      <span className="meter-value">{value}</span>
    </div>
  )
}

/**
 * Live CPU / memory / token-throughput meters for the sidebar header. CPU and
 * memory are system-wide; the token meter shows how hard Claude is working right
 * now across all live sessions (rate, not a quota — the real quota lives on the
 * linked usage page).
 */
export function SystemStats(): JSX.Element {
  const [s, setS] = useState<Stats | null>(null)

  useEffect(() => window.cockpit.onSystemStats(setS), [])

  const rate = s?.tokenRate ?? 0
  return (
    <div className="sys-stats">
      <Meter label="CPU" tone="cpu" percent={s?.cpu ?? 0} value={`${Math.round(s?.cpu ?? 0)}%`} />
      <Meter
        label="MEM"
        tone="mem"
        percent={s?.memPercent ?? 0}
        value={`${Math.round(s?.memPercent ?? 0)}%`}
        title={s ? `${fmtGiB(s.memUsed)} / ${fmtGiB(s.memTotal)} GiB` : undefined}
      />
      <Meter
        label="TOK"
        tone="tok"
        percent={(rate / TOKEN_RATE_FULL_SCALE) * 100}
        value={rate >= 1 ? `${fmtTokens(rate)}/s` : 'idle'}
        title={
          s
            ? `${fmtTokens(rate)} tokens/sec across live sessions · ${fmtTokens(
                s.tokensTotal
              )} this run — click to open your usage page`
            : undefined
        }
      />
      <button
        className="sys-usage-link"
        title="Open your Claude usage & limits page"
        onClick={() => window.cockpit.openExternal(CLAUDE_USAGE_URL)}
      >
        ↗
      </button>
    </div>
  )
}
