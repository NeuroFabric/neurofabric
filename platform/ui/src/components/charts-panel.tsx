import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts'

export interface SeverityBucket {
  t: string
  critical: number
  warning: number
  info: number
}

export interface BlastSlice { name: string; value: number; color: string }

const TOOLTIP_STYLE = { background: '#0e1522', border: '1px solid rgba(255,255,255,0.08)', fontSize: 11 }

const SEVERITY_COLORS = { critical: '#f43f5e', warning: '#f59e0b', info: '#06b6d4' } as const

export interface IngestionTopologyData {
  topSources: Array<{ source: string; count: number }>
  severities: Record<'critical' | 'warning' | 'info', number>
}

export function SourceTopology({ ingestion }: { ingestion: IngestionTopologyData | null }) {
  const top = (ingestion?.topSources ?? []).slice(0, 6)
  const max = Math.max(1, ...top.map((s) => s.count))
  const sev = ingestion?.severities ?? { critical: 0, warning: 0, info: 0 }
  const sevTotal = Math.max(1, sev.critical + sev.warning + sev.info)

  return (
    <div className="rounded-lg border border-white/[0.08] bg-[#111827] p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">Ingestion Source Topology</h3>
      <div className="flex flex-col gap-2">
        {top.length === 0 ? (
          <p className="text-[11px] text-zinc-600">Awaiting emitters...</p>
        ) : top.map((s) => (
          <div key={s.source} className="flex items-center gap-2">
            <span className="w-28 truncate text-[10px] font-mono text-zinc-400">{s.source}</span>
            <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
              <div className="h-full bg-cyan-500/80 transition-all" style={{ width: `${Math.round((s.count / max) * 100)}%` }} />
            </div>
            <span className="w-12 text-right text-[10px] tabular-nums text-zinc-500">{s.count}</span>
          </div>
        ))}
      </div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mt-4 mb-2">Raw Severity Ratio</h3>
      <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-zinc-800">
        <div style={{ width: `${(sev.critical / sevTotal) * 100}%`, backgroundColor: SEVERITY_COLORS.critical }} />
        <div style={{ width: `${(sev.warning / sevTotal) * 100}%`, backgroundColor: SEVERITY_COLORS.warning }} />
        <div style={{ width: `${(sev.info / sevTotal) * 100}%`, backgroundColor: SEVERITY_COLORS.info }} />
      </div>
      <div className="mt-2 flex items-center gap-3 text-[9px] font-bold uppercase tracking-wider">
        <span style={{ color: SEVERITY_COLORS.critical }}>Critical {sev.critical}</span>
        <span style={{ color: SEVERITY_COLORS.warning }}>Warning {sev.warning}</span>
        <span style={{ color: SEVERITY_COLORS.info }}>Info {sev.info}</span>
      </div>
    </div>
  )
}

export function ChartsPanel({ series, blast, ingestion }: { series: SeverityBucket[]; blast: BlastSlice[]; ingestion?: IngestionTopologyData | null }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 rounded-lg border border-white/[0.08] bg-[#111827] p-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Telemetry Volume &amp; Severity — last 30 min
        </h3>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 9, fill: '#52525b' }} interval={9} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: '#52525b' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#a1a1aa' }} />
              <Area type="monotone" dataKey="critical" stackId="1" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.25} isAnimationActive={false} />
              <Area type="monotone" dataKey="warning" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25} isAnimationActive={false} />
              <Area type="monotone" dataKey="info" stackId="1" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.25} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="rounded-lg border border-white/[0.08] bg-[#111827] p-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Blast Radius Distribution
        </h3>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={blast} dataKey="value" nameKey="name" innerRadius={42} outerRadius={64} paddingAngle={3} isAnimationActive={false}>
                {blast.map((d) => <Cell key={d.name} fill={d.color} />)}
              </Pie>
              <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: '#a1a1aa' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
      <SourceTopology ingestion={ingestion ?? null} />
    </div>
  )
}
