import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Radio } from 'lucide-react'
import { KpiStrip, type KpiSample } from './components/kpi-strip'
import { ChartsPanel, type SeverityBucket, type BlastSlice } from './components/charts-panel'
import { HitlDeck, type HitlProposal } from './components/hitl-deck'
import { GovernanceLedger } from './components/governance-ledger'
import { fetchLedger, type ApprovalLedgerRecord } from './lib/api'

interface TelemetryEvent {
  id: string
  source: string
  severity: string
  message: string
  timestamp: string
  rawLog?: string
}

interface OpsMetrics { suppressedAlerts: number; streamLagMs: number; sanitizedSecrets?: number }

const SEV_COLORS: Record<string, string> = { critical: '#f43f5e', warning: '#f59e0b', info: '#06b6d4' }

function severityBadge(severity: string) {
  const color = SEV_COLORS[severity?.toLowerCase()] ?? SEV_COLORS.info
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
      style={{ backgroundColor: `${color}1a`, color, border: `1px solid ${color}33` }}>
      {severity}
    </span>
  )
}

export default function App() {
  const [telemetry, setTelemetry] = useState<TelemetryEvent[]>([])
  const [proposals, setProposals] = useState<HitlProposal[]>([])
  const [records, setRecords] = useState<ApprovalLedgerRecord[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [inspect, setInspect] = useState<TelemetryEvent | null>(null)
  const [ops, setOps] = useState<OpsMetrics>({ suppressedAlerts: 0, streamLagMs: 0 })
  const [tpHistory, setTpHistory] = useState<KpiSample[]>([])
  const [confHistory, setConfHistory] = useState<KpiSample[]>([])
  const eventTimes = useRef<number[]>([])

  const loadLedger = useCallback(async () => {
    try { setRecords(await fetchLedger()) } catch { /* fetchLedger returns [] on error */ }
  }, [])

  const loadOps = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/ops/metrics')
      if (res.ok) setOps(await res.json())
    } catch { /* metrics endpoint optional */ }
  }, [])

  useEffect(() => {
    loadLedger(); loadOps()
    const t = setInterval(loadOps, 10_000)
    return () => clearInterval(t)
  }, [loadLedger, loadOps])

  /* ---- decisions ---- */
  const decide = useCallback(async (taskId: string, decision: 'APPROVED' | 'REJECTED') => {
    setProposals((prev) => prev.filter((p) => p.taskId !== taskId))
    try {
      await fetch('/api/v1/embassy/decisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, decision }),
      })
      loadLedger()
    } catch (err) { console.error('decision failed', err) }
  }, [loadLedger])

  /* ---- SSE ---- */
  useEffect(() => {
    const es = new EventSource('/api/v1/stream/alerts')
    es.onopen = () => setIsConnected(true)
    es.onerror = () => setIsConnected(false)
    es.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'TELEMETRY_EVENT') {
          eventTimes.current.push(Date.now())
          setTelemetry((prev) => [message.data as TelemetryEvent, ...prev].slice(0, 200))
        } else if (message.type === 'HITL_PROPOSAL') {
          const p = message.data as HitlProposal
          setProposals((prev) => prev.some((x) => x.taskId === p.taskId) ? prev : [p, ...prev])
          loadLedger()
        } else if (message.type === 'DECISION_RESOLVED') {
          setProposals((prev) => prev.filter((p) => p.taskId !== (message.data as { taskId: string }).taskId))
          loadLedger()
        }
      } catch { /* ignore malformed frames */ }
    }
    return () => es.close()
  }, [loadLedger])

  /* ---- rolling KPI samples (every 5s) ---- */
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      const cutoff = now - 60_000
      eventTimes.current = eventTimes.current.filter((ts) => ts > cutoff)
      setTpHistory((prev) => [...prev, { t: now, v: Math.round(eventTimes.current.length / 60 * 10) / 10 }].slice(-60))
      setConfHistory((prev) => {
        const confs = proposals.map((p) => p.confidence).filter((c) => typeof c === 'number')
        const avg = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : 0
        return [...prev, { t: now, v: avg }].slice(-60)
      })
    }, 5_000)
    return () => clearInterval(t)
  }, [proposals])

  /* ---- derived data ---- */
  const throughputPerSec = useMemo(() => {
    const cutoff = Date.now() - 60_000, n = telemetry.filter((e) => Date.parse(e.timestamp) > cutoff).length
    return Math.round((n / 60) * 10) / 10
  }, [telemetry])

  const avgConfidence = useMemo(() => {
    const c = proposals.map((p) => p.confidence).filter((x) => typeof x === 'number')
    return c.length ? Math.round(c.reduce((a, b) => a + b, 0) / c.length) : 0
  }, [proposals])

  const autonomyRatio = useMemo(() => {
    const resolved = records.filter((r) => {
      const s = r.status?.toUpperCase()
      return s === 'APPROVED' || s === 'AUTONOMOUSLY_APPLIED' || s === 'AUTONOMOUS'
    }).length
    const total = resolved + records.filter((r) => r.status?.toUpperCase() === 'REJECTED').length + proposals.length
    return total === 0 ? 100 : Math.round((resolved / total) * 1000) / 10
  }, [records, proposals])

  const mttrSeconds = useMemo(() => {
    const deltas: number[] = []
    for (const r of records) {
      const created = r.createdAt ? Date.parse(r.createdAt) : NaN
      const decided = r.decidedAt ? Date.parse(r.decidedAt) : NaN
      if (Number.isFinite(created) && Number.isFinite(decided) && decided >= created) deltas.push((decided - created) / 1000)
    }
    if (!deltas.length) return 0
    return Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
  }, [records])

  const severitySeries: SeverityBucket[] = useMemo(() => {
    const now = Date.now()
    const buckets: SeverityBucket[] = Array.from({ length: 30 }, (_, i) => {
      const start = now - (29 - i) * 60_000
      return { t: new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), critical: 0, warning: 0, info: 0 }
    })
    for (const ev of telemetry) {
      const ts = Date.parse(ev.timestamp)
      if (!Number.isFinite(ts) || ts < now - 30 * 60_000) continue
      const idx = Math.min(29, Math.floor((ts - (now - 30 * 60_000)) / 60_000))
      const sev = ev.severity?.toLowerCase()
      if (sev === 'critical') buckets[idx].critical++
      else if (sev === 'warning') buckets[idx].warning++
      else buckets[idx].info++
    }
    return buckets
  }, [telemetry])

  const blastDistribution: BlastSlice[] = useMemo(() => {
    const counts: Record<string, number> = { low: 0, medium: 0, high: 0 }
    for (const p of proposals) counts[p.blastRadius] = (counts[p.blastRadius] ?? 0) + 1
    const out = [
      { name: 'Low (Auto)', value: counts.low, color: '#10b981' },
      { name: 'Medium', value: counts.medium, color: '#f59e0b' },
      { name: 'High (HITL)', value: counts.high, color: '#f43f5e' },
    ].filter((d) => d.value > 0)
    return out.length ? out : [{ name: 'No proposals', value: 1, color: '#1f2937' }]
  }, [proposals])

  return (
    <div className="min-h-screen bg-[#090d16] text-zinc-50 font-sans selection:bg-indigo-500/30">
      <header className="border-b border-white/[0.08] bg-[#090d16]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-indigo-500/20 flex items-center justify-center border border-indigo-500/30">
              <Radio className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <h1 className="font-semibold text-sm tracking-wide">NeuroFabric Ops</h1>
            <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-white/[0.08] text-[10px] font-medium text-zinc-400 ml-2">ENTERPRISE</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
            <span className="relative flex h-2 w-2">
              {isConnected && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            </span>
            {isConnected ? 'Real-Time Stream Active' : 'Connecting to Stream...'}
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-6 flex flex-col gap-6">
        <KpiStrip
          throughputPerSec={throughputPerSec}
          throughputHistory={tpHistory}
          suppressedAlerts={ops.suppressedAlerts}
          sanitizedSecrets={ops.sanitizedSecrets ?? 0}
          streamLagMs={ops.streamLagMs}
          pendingCount={proposals.length}
          autonomyRatio={autonomyRatio}
          mttrSeconds={mttrSeconds}
          avgConfidence={avgConfidence}
          confidenceHistory={confHistory}
        />

        <ChartsPanel series={severitySeries} blast={blastDistribution} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="flex flex-col gap-3">
            <header className="flex items-center gap-2 px-1">
              <Radio className="w-4 h-4 text-zinc-400" />
              <h2 className="text-sm font-medium text-zinc-200">Live Telemetry</h2>
              <span className="ml-auto text-[10px] tabular-nums text-zinc-500">{telemetry.length} EVENTS</span>
            </header>
            <div className="rounded-lg border border-white/[0.08] bg-[#111827] overflow-hidden">
              <div className="grid grid-cols-[96px_120px_96px_minmax(0,1fr)] border-b border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                <div>Severity</div><div>Source</div><div>Time</div><div>Message</div>
              </div>
              <div className="max-h-96 overflow-auto">
                {telemetry.length === 0 ? (
                  <div className="flex h-32 items-center justify-center text-xs text-zinc-600">Awaiting telemetry stream...</div>
                ) : telemetry.map((ev) => (
                  <button
                    key={ev.id}
                    onClick={() => setInspect(ev)}
                    className="grid w-full grid-cols-[96px_120px_96px_minmax(0,1fr)] items-center px-4 py-2.5 text-left text-[11px] border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors"
                  >
                    <span>{severityBadge(ev.severity)}</span>
                    <span className="truncate text-zinc-400">{ev.source}</span>
                    <span className="tabular-nums text-zinc-500">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                    <span className="truncate text-zinc-300">{ev.message}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <header className="flex items-center gap-2 px-1">
              <h2 className="text-sm font-medium text-zinc-200">Embassy Approvals (HITL)</h2>
              <span className="ml-auto text-[10px] tabular-nums text-zinc-500">{proposals.length} PENDING</span>
            </header>
            <HitlDeck proposals={proposals} onDecide={decide} />
          </section>
        </div>

        <GovernanceLedger records={records} />
      </main>

      {inspect && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setInspect(null)}>
          <div className="max-w-2xl w-full mx-4 rounded-lg border border-white/[0.08] bg-[#0e1522] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {severityBadge(inspect.severity)}
                <span className="font-mono text-[11px] text-zinc-400">{inspect.source}</span>
              </div>
              <button onClick={() => setInspect(null)} className="text-zinc-500 hover:text-white text-sm">✕</button>
            </div>
            <p className="text-xs text-zinc-300 mb-3">{inspect.message}</p>
            <pre className="max-h-80 overflow-auto rounded-md border border-white/[0.06] bg-[#070c16] p-4 font-mono text-[11px] leading-relaxed text-zinc-400">
              {inspect.rawLog || JSON.stringify(inspect, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
