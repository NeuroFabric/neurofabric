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

export function ChartsPanel({ series, blast }: { series: SeverityBucket[]; blast: BlastSlice[] }) {
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
    </div>
  )
}
