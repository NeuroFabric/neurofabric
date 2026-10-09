import { Zap, ShieldOff, KeyRound, Timer, ShieldCheck, Activity, Clock, Gauge } from 'lucide-react'
import { AreaChart, Area, ResponsiveContainer } from 'recharts'

export interface KpiSample { t: number; v: number }

export interface KpiStripProps {
  throughputPerSec: number
  throughputHistory: KpiSample[]
  suppressedAlerts: number
  sanitizedSecrets: number
  streamLagMs: number
  pendingCount: number
  autonomyRatio: number
  mttrSeconds: number
  avgConfidence: number
  confidenceHistory: KpiSample[]
}

function Sparkline({ data, color }: { data: KpiSample[]; color: string }) {
  if (data.length < 2) return <div className="h-6" />
  return (
    <div className="h-6 w-full mt-1">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <Area type="monotone" dataKey="v" stroke={color} fill={color} fillOpacity={0.18} strokeWidth={1.2} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function KpiCard({ icon: Icon, label, value, accent, badge, spark }: {
  icon: any; label: string; value: string; accent: string; badge?: React.ReactNode; spark?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-[#111827] p-3 flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2">
        <div className="rounded-md p-1.5 shrink-0" style={{ backgroundColor: `${accent}1a`, color: accent }}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 truncate">{label}</span>
        {badge}
      </div>
      <span className="text-lg font-semibold tabular-nums text-zinc-100 leading-tight">{value}</span>
      {spark}
    </div>
  )
}

const pulse = (
  <span className="ml-auto relative flex h-1.5 w-1.5">
    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-500" />
  </span>
)

export function KpiStrip(p: KpiStripProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
      <KpiCard icon={Zap} label="Throughput" value={`${p.throughputPerSec} evt/s`} accent="#06b6d4" badge={pulse}
        spark={<Sparkline data={p.throughputHistory} color="#06b6d4" />} />
      <KpiCard icon={ShieldOff} label="Alerts Suppressed" value={String(p.suppressedAlerts)} accent="#a78bfa" />
      <KpiCard icon={KeyRound} label="Secrets Scrubbed" value={String(p.sanitizedSecrets)} accent="#f472b6" />
      <KpiCard icon={Timer} label="Stream Lag" value={`${p.streamLagMs}ms`} accent="#fbbf24" />
      <KpiCard icon={ShieldCheck} label="HITL Pending" value={String(p.pendingCount)} accent="#f59e0b"
        badge={p.pendingCount > 0 ? <span className="ml-auto rounded bg-amber-500/20 border border-amber-500/40 px-1 text-[8px] font-bold text-amber-400">ACT</span> : undefined} />
      <KpiCard icon={Activity} label="Autonomy" value={`${p.autonomyRatio}%`} accent="#10b981"
        spark={
          <div className="mt-1 h-1 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${p.autonomyRatio}%` }} />
          </div>
        } />
      <KpiCard icon={Clock} label="MTTR" value={`${p.mttrSeconds}s`} accent="#38bdf8" />
      <KpiCard icon={Gauge} label="Avg Confidence" value={`${p.avgConfidence}%`} accent="#818cf8"
        spark={<Sparkline data={p.confidenceHistory} color="#818cf8" />} />
    </div>
  )
}
