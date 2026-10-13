import { useTelemetry } from '../context/TelemetryContext';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { toast } from 'sonner';
import { Activity, ShieldAlert, Cpu, HeartPulse } from 'lucide-react';

export function OverviewPage() {
  const { timeseries, logs, triggerProbe } = useTelemetry();

  const latestPoint = timeseries[timeseries.length - 1] || {
    throughput: 16.4,
    p50: 285,
    p95: 306,
    errorRate: 0,
    slaBudget: 99.98,
  };

  const chartData = timeseries.length > 0 ? timeseries : [
    { timestamp: '12:00', throughput: 14.2, p50: 280, p95: 300 },
    { timestamp: '12:01', throughput: 15.1, p50: 282, p95: 302 },
    { timestamp: '12:02', throughput: 16.4, p50: 285, p95: 306 },
    { timestamp: '12:03', throughput: 16.2, p50: 284, p95: 305 },
    { timestamp: '12:04', throughput: 17.0, p50: 289, p95: 310 },
  ];

  const handleHeartbeat = async () => {
    try {
      await triggerProbe('auth-gateway', false);
      toast.success('Heartbeat Emitted', { description: 'Live event recorded to telemetry stream.' });
    } catch (e: any) {
      toast.error('Probe Failed', { description: e.message });
    }
  };

  const handleAnomaly = async () => {
    try {
      await triggerProbe('flapping-payment-worker', true);
      toast.error('Anomaly Injected', { description: 'Credential leak simulated. Breaker strike recorded.' });
    } catch (e: any) {
      toast.error('Probe Failed', { description: e.message });
    }
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl font-sans">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Command Center</h1>
          <p className="text-xs text-slate-400 mt-1">Live edge throughput waveforms and autonomous remediation metrics</p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={handleHeartbeat}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-white rounded-xl transition font-medium flex items-center space-x-1.5"
          >
            <HeartPulse className="w-3.5 h-3.5 text-cyan-400" />
            <span>Emit Heartbeat</span>
          </button>
          <button
            onClick={handleAnomaly}
            className="px-4 py-2 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-xs text-rose-300 rounded-xl transition font-medium flex items-center space-x-1.5"
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Inject Anomaly & Leak</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>Ingestion Velocity</span>
            <Activity className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-cyan-400 mt-2 tabular-nums">
            {latestPoint.throughput ?? 16.4} <span className="text-xs font-sans text-slate-500">evt/s</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>Transit Latency (P50)</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-2 tabular-nums">
            {latestPoint.p50 ?? 285} <span className="text-xs font-sans text-slate-500">ms</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>Critical Path (P95)</span>
            <Activity className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-400 mt-2 tabular-nums">
            {latestPoint.p95 ?? 306} <span className="text-xs font-sans text-slate-500">ms</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
            <span>SLA Budget (99.9%)</span>
            <span className="text-[10px] font-mono text-emerald-400 font-bold">NOMINAL</span>
          </div>
          <div className="text-2xl font-bold font-mono text-white mt-2 tabular-nums">
            {latestPoint.slaBudget ?? 99.98}%
          </div>
        </div>
      </div>

      {/* Recharts Charts Grid */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Ingestion Velocity Waveform */}
        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="font-semibold text-white text-sm">1. Ingestion Velocity (Throughput)</div>
              <div className="text-xs text-slate-400 mt-0.5">Real-time edge ingestion rate with backpressure limits</div>
            </div>
            <span className="text-xs font-mono font-bold text-cyan-400">{latestPoint.throughput ?? 16.4} evt/s</span>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="velocityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp" stroke="#475569" fontSize={10} tickLine={false} />
                <YAxis stroke="#475569" fontSize={10} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '11px', fontFamily: 'monospace' }}
                />
                <Area type="monotone" dataKey="throughput" stroke="#06b6d4" strokeWidth={2} fillOpacity={1} fill="url(#velocityGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Latency Distribution */}
        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="font-semibold text-white text-sm">2. Latency Tail Distribution (P50 / P95)</div>
              <div className="text-xs text-slate-400 mt-0.5">TLS handshake transit and SQLite commit distribution</div>
            </div>
            <span className="text-xs font-mono font-bold text-emerald-400">{latestPoint.p50 ?? 285}ms / {latestPoint.p95 ?? 306}ms</span>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <XAxis dataKey="timestamp" stroke="#475569" fontSize={10} tickLine={false} />
                <YAxis stroke="#475569" fontSize={10} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', fontSize: '11px', fontFamily: 'monospace' }}
                />
                <Bar dataKey="p50" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="p95" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Real-time Stream Snapshot */}
      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
        <div className="font-semibold text-white text-sm mb-4">Captured Telemetry Buffer</div>
        <div className="space-y-2 font-mono text-xs">
          {logs.slice(0, 5).map((log, i) => (
            <div key={i} className="p-3 bg-slate-900/60 rounded-xl border border-slate-800/80 flex items-center justify-between">
              <div className="flex items-center space-x-3 truncate">
                <span className={`font-bold ${log.severity === 'CRITICAL' ? 'text-rose-400' : 'text-cyan-400'}`}>
                  [{log.severity}]
                </span>
                <span className="text-slate-300 font-semibold">{log.service}:</span>
                <span className="text-slate-400 truncate">{log.message}</span>
              </div>
              {log.dlpScrubbed && (
                <span className="text-[10px] bg-amber-950 text-amber-400 border border-amber-800 px-2 py-0.5 rounded font-bold">
                  DLP SCRUBBED
                </span>
              )}
            </div>
          ))}
          {logs.length === 0 && (
            <div className="text-slate-500 py-4 text-center">No telemetry captured yet. Click "Emit Heartbeat" above.</div>
          )}
        </div>
      </div>
    </div>
  );
}
