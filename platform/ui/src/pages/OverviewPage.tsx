import { useTelemetry } from '../context/TelemetryContext';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Activity, ShieldAlert, Cpu, HeartPulse, Zap, ShieldCheck } from 'lucide-react';

export function OverviewPage() {
  const { timeseries, logs, triggerProbe } = useTelemetry();

  const current = timeseries[timeseries.length - 1] || {
    throughput: 16.4,
    p50: 285,
    p95: 306,
    p99: 395,
    errorRate: 0,
    slaBudget: 99.98,
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      {/* Top Banner: HUD Control Strip */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-5 rounded-2xl bg-[#0d121d] border border-slate-800/80">
        <div>
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <h1 className="text-xl font-extrabold text-white tracking-tight">SRE Command Center</h1>
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800">
              CLUSTER HUD
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Sub-second edge telemetry ingestion, in-flight DLP, and autonomous GitOps policy evaluation.
          </p>
        </div>

        {/* Live Interactive Action Buttons */}
        <div className="flex items-center space-x-3">
          <button
            onClick={() => triggerProbe('auth-gateway', false)}
            className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 hover:border-cyan-500/50 text-xs text-slate-200 hover:text-white rounded-xl transition font-medium flex items-center space-x-2 shadow-sm"
          >
            <HeartPulse className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span>Emit Heartbeat</span>
          </button>

          <button
            onClick={() => triggerProbe('flapping-payment-worker', true)}
            className="px-4 py-2.5 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/40 text-xs text-rose-300 hover:text-rose-200 rounded-xl transition font-medium flex items-center space-x-2 shadow-lg shadow-rose-950/20"
          >
            <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
            <span>Inject Anomaly & Leak</span>
          </button>
        </div>
      </div>

      {/* KPI 4-Card Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800/80 relative overflow-hidden">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>Ingestion Velocity</span>
            <Activity className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-3xl font-extrabold font-mono text-cyan-400 mt-2 tracking-tight tabular-nums">
            {current.throughput} <span className="text-xs font-sans text-slate-500 font-medium">evt/s</span>
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-2 flex items-center space-x-1">
            <span className="text-emerald-400 font-bold">↑ 2.4%</span>
            <span>vs previous window</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800/80 relative overflow-hidden">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>Transit Latency (P50)</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-3xl font-extrabold font-mono text-emerald-400 mt-2 tracking-tight tabular-nums">
            {current.p50} <span className="text-xs font-sans text-slate-500 font-medium">ms</span>
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-2 flex items-center space-x-1">
            <span className="text-emerald-400 font-bold">NOMINAL</span>
            <span>TLS + SQLite WAL</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800/80 relative overflow-hidden">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>Critical Path (P95)</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-3xl font-extrabold font-mono text-amber-400 mt-2 tracking-tight tabular-nums">
            {current.p95} <span className="text-xs font-sans text-slate-500 font-medium">ms</span>
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-2">
            Tail distribution (P99: <span className="text-white font-bold">{current.p99 || 395}ms</span>)
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800/80 relative overflow-hidden">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>SLA Availability</span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-3xl font-extrabold font-mono text-white mt-2 tracking-tight tabular-nums">
            {current.slaBudget}%
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-2">
            Error Budget Burn: <span className="text-emerald-400 font-bold">0.00%</span>
          </div>
        </div>
      </div>

      {/* 2 High-Density Charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Chart 1: Ingestion Velocity Waveform */}
        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="font-bold text-white text-sm">1. INGESTION VELOCITY (5-MINUTE ROLLING)</div>
              <div className="text-xs text-slate-400 mt-0.5">Real-time edge worker throughput with backpressure limits</div>
            </div>
            <div className="text-right font-mono">
              <span className="text-xs font-bold text-cyan-400">{current.throughput} evt/s</span>
              <div className="text-[10px] text-slate-500">Peak: {((current.throughput ?? 16.4) + 2.5).toFixed(1)}</div>
            </div>
          </div>

          <div className="h-56 w-full pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={timeseries}>
                <defs>
                  <linearGradient id="velocityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#06b6d4" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp" stroke="#334155" fontSize={10} tickLine={false} />
                <YAxis stroke="#334155" fontSize={10} tickLine={false} domain={['dataMin - 2', 'dataMax + 4']} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#07090e',
                    borderColor: 'rgba(6,182,212,0.4)',
                    borderRadius: '12px',
                    fontSize: '11px',
                    fontFamily: 'monospace',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="throughput"
                  stroke="#06b6d4"
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#velocityGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: P50 / P95 / P99 Latency Percentiles */}
        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="font-bold text-white text-sm">2. GATEWAY ROUNDTRIP LATENCY (P50 / P95 / P99)</div>
              <div className="text-xs text-slate-400 mt-0.5">TLS edge handshake transit, policy check, and commit latency</div>
            </div>
            <div className="text-right font-mono text-xs">
              <span className="text-emerald-400 font-bold">{current.p50}ms</span>
              <span className="text-slate-500"> / </span>
              <span className="text-amber-400 font-bold">{current.p95}ms</span>
            </div>
          </div>

          <div className="h-56 w-full pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeseries}>
                <XAxis dataKey="timestamp" stroke="#334155" fontSize={10} tickLine={false} />
                <YAxis stroke="#334155" fontSize={10} tickLine={false} domain={['dataMin - 10', 'dataMax + 20']} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#07090e',
                    borderColor: 'rgba(16,185,129,0.4)',
                    borderRadius: '12px',
                    fontSize: '11px',
                    fontFamily: 'monospace',
                  }}
                />
                <ReferenceLine y={450} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'SLA Breached', fill: '#ef4444', fontSize: 10 }} />
                <Line type="monotone" dataKey="p50" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="p95" stroke="#f59e0b" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="p99" stroke="#fb7185" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Captured Stream Snapshot */}
      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800/80">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-white text-sm">LIVE INGESTION & IN-FLIGHT DLP STREAM</div>
          <span className="text-xs font-mono text-slate-500">Buffer: {logs.length} events</span>
        </div>

        <div className="space-y-2 font-mono text-xs">
          {logs.slice(0, 5).map((log) => (
            <div
              key={log.id}
              className="p-3 bg-slate-900/50 rounded-xl border border-slate-800/80 flex items-center justify-between gap-4"
            >
              <div className="flex items-center space-x-3 truncate">
                <span className="text-[10px] text-slate-500 w-16 shrink-0">
                  {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : 'NOW'}
                </span>
                <span
                  className={`font-bold shrink-0 ${
                    log.severity === 'CRITICAL' ? 'text-rose-400' : 'text-cyan-400'
                  }`}
                >
                  [{log.severity}]
                </span>
                <span className="text-slate-200 font-semibold shrink-0">{log.service}:</span>
                <span className="text-slate-400 truncate">{log.message}</span>
              </div>
              {log.dlpScrubbed && (
                <span className="shrink-0 text-[10px] bg-amber-950 text-amber-300 border border-amber-800/60 px-2 py-0.5 rounded font-bold">
                  DLP SCRUBBED
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
