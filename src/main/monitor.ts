import { EventEmitter } from 'events'
import os from 'os'
import type { SystemStats } from '../shared/types.js'

/** Aggregate CPU jiffies across all cores; delta between samples gives utilisation. */
function cpuTimes(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const v of Object.values(cpu.times)) total += v
    idle += cpu.times.idle
  }
  return { idle, total }
}

/**
 * Samples system-wide CPU + memory and this app's Claude token throughput on an
 * interval, emitting a `stats` (SystemStats) event for the renderer's sidebar
 * meters. CPU is derived from the delta of idle/total jiffies between ticks;
 * token rate is the delta of cumulative session tokens over elapsed time,
 * exponentially smoothed so a single large turn doesn't spike the meter.
 *
 * Emits: 'stats' (SystemStats)
 */
export class SystemMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private lastCpu = cpuTimes()
  private lastTokens = 0
  private lastTs = Date.now()
  private smoothedRate = 0

  /** @param totalTokens returns cumulative tokens across all live sessions. */
  constructor(
    private readonly totalTokens: () => number,
    private readonly intervalMs = 2000
  ) {
    super()
  }

  start(): void {
    if (this.timer) return
    // Baseline so the first emitted sample is a real delta, not a cold spike.
    this.lastCpu = cpuTimes()
    this.lastTokens = this.totalTokens()
    this.lastTs = Date.now()
    this.timer = setInterval(() => this.sample(), this.intervalMs)
    if (this.timer.unref) this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private sample(): void {
    const cur = cpuTimes()
    const dIdle = cur.idle - this.lastCpu.idle
    const dTotal = cur.total - this.lastCpu.total
    this.lastCpu = cur
    const cpu = dTotal > 0 ? Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal))) : 0

    const memTotal = os.totalmem()
    const memUsed = memTotal - os.freemem()
    const memPercent = memTotal > 0 ? (100 * memUsed) / memTotal : 0

    const now = Date.now()
    const tokensTotal = this.totalTokens()
    const dt = (now - this.lastTs) / 1000
    // Only count growth — a session closing (its tokens leaving the sum) isn't usage.
    const dTokens = Math.max(0, tokensTotal - this.lastTokens)
    const instRate = dt > 0 ? dTokens / dt : 0
    // Exponential smoothing: half old, half new — enough to settle bursty per-turn writes.
    this.smoothedRate = this.smoothedRate * 0.5 + instRate * 0.5
    this.lastTokens = tokensTotal
    this.lastTs = now

    const stats: SystemStats = {
      cpu,
      memPercent,
      memUsed,
      memTotal,
      tokenRate: this.smoothedRate,
      tokensTotal
    }
    this.emit('stats', stats)
  }
}
