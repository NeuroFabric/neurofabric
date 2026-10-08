import { useCallback, useEffect, useState } from 'react'
import { Radio, ShieldCheck } from 'lucide-react'
import { TelemetryFeed, type Alert } from './components/telemetry-feed'
import { PendingApprovals } from './components/pending-approvals'
import { fetchPatches, type PatchProposal } from './lib/api'

export default function App() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [patches, setPatches] = useState<PatchProposal[]>([])
  const [lastSync, setLastSync] = useState<Date | null>(null)

  // Simulated telemetry feed (swap with fetchTelemetry() against a live conductor)
  useEffect(() => {
    setAlerts([
      { severity: 'critical', source: 'datadog', timestamp: '2025-10-04T12:00:00Z', message: 'Pod OOMKilled: neurofebric-wedge' },
      { severity: 'warning', source: 'splunk', timestamp: '2025-10-04T12:05:00Z', message: 'Database connection pool saturated' },
    ])
  }, [])

  // Poll remediation patches on a fixed cadence
  const loadPatches = useCallback(async () => {
    try {
      const p = await fetchPatches()
      setPatches(p)
      setLastSync(new Date())
    } catch (e) {
      console.error('Failed to fetch patches', e)
    }
  }, [])

  useEffect(() => {
    loadPatches()
    const interval = setInterval(loadPatches, 5000)
    return () => clearInterval(interval)
  }, [loadPatches])

  return (
    <div className="min-h-screen bg-[#070b14] p-8 font-sans text-slate-200">
      <header className="mb-12 border-b border-white/[0.08] pb-8">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Incident Commander</h1>
            <p className="mt-1 text-sm text-slate-400">Governance &amp; Remediation Surface</p>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-slate-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            {lastSync ? `SYNC ${lastSync.toISOString()}` : 'SYNC —'}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <div className="mb-4 flex items-center gap-2">
            <Radio size={14} className="text-amber-400" />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Telemetry Feed
            </h2>
          </div>
          <div className="h-full">
            <TelemetryFeed alerts={alerts} />
          </div>
        </section>

        <section>
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck size={14} className="text-emerald-400" />
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Pending Approvals
            </h2>
          </div>
          <div className="h-full">
            <PendingApprovals patches={patches} />
          </div>
        </section>
      </div>
    </div>
  )
}
