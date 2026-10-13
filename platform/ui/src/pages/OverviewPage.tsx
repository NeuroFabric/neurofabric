import { useTelemetry } from '../context/TelemetryContext';

export function OverviewPage() {
  const { timeseries, logs, triggerProbe } = useTelemetry();

  const latestPoint = timeseries[timeseries.length - 1] || {
    throughput: 16.4,
    p50: 285,
    p95: 306,
    errorRate: 0,
    slaBudget: 99.98,
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      {/* Top Header & Interactive Test Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Command Center</h1>
          <p className="text-xs text-slate-400 mt-1">Real-time edge ingestion metrics and closed-loop telemetry</p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => triggerProbe('auth-gateway', false)}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-white rounded-lg transition font-medium"
          >
            + Ingest Heartbeat
          </button>
          <button
            onClick={() => triggerProbe('flapping-payment-worker', true)}
            className="px-3.5 py-2 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-xs text-rose-300 rounded-lg transition font-medium"
          >
            ! Inject Anomaly & Leak
          </button>
        </div>
      </div>

      {/* KPI Cards Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="text-xs text-slate-400 font-medium">Ingestion Velocity</div>
          <div className="text-2xl font-bold font-mono text-cyan-400 mt-2 tabular-nums">
            {latestPoint.throughput ?? 16.4} <span className="text-xs font-sans text-slate-500">evt/s</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="text-xs text-slate-400 font-medium">Transit Latency (P50)</div>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-2 tabular-nums">
            {latestPoint.p50 ?? 285} <span className="text-xs font-sans text-slate-500">ms</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="text-xs text-slate-400 font-medium">Critical Path (P95)</div>
          <div className="text-2xl font-bold font-mono text-amber-400 mt-2 tabular-nums">
            {latestPoint.p95 ?? 306} <span className="text-xs font-sans text-slate-500">ms</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0d121d] border border-slate-800">
          <div className="text-xs text-slate-400 font-medium">SLA Availability Budget</div>
          <div className="text-2xl font-bold font-mono text-white mt-2 tabular-nums">
            {latestPoint.slaBudget ?? 99.98}%
          </div>
        </div>
      </div>

      {/* Metric Waveforms Grid */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-white text-sm">1. Ingestion Velocity (Rolling Window)</span>
              <span className="text-xs font-mono text-cyan-400 font-bold">{latestPoint.throughput ?? 16.4} evt/s</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Real-time edge worker throughput with adaptive backpressure.</p>
          </div>
          <div className="h-32 mt-6 flex items-end gap-1.5 pt-4 border-b border-slate-800">
            {timeseries.slice(-20).map((pt, i) => (
              <div
                key={i}
                className="flex-1 bg-cyan-500/40 hover:bg-cyan-400 transition rounded-t"
                style={{ height: `${Math.min(100, Math.max(15, (pt.throughput || 16) * 4))}%` }}
                title={`${pt.timestamp}: ${pt.throughput} evt/s`}
              />
            ))}
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-white text-sm">2. Latency Distribution (P50/P95)</span>
              <span className="text-xs font-mono text-emerald-400 font-bold">{latestPoint.p50 ?? 285}ms / {latestPoint.p95 ?? 306}ms</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">End-to-end TLS transit and SQLite write commit latency.</p>
          </div>
          <div className="h-32 mt-6 flex items-end gap-1.5 pt-4 border-b border-slate-800">
            {timeseries.slice(-20).map((pt, i) => (
              <div
                key={i}
                className="flex-1 bg-emerald-500/40 hover:bg-emerald-400 transition rounded-t"
                style={{ height: `${Math.min(100, Math.max(20, (pt.p50 || 285) / 4))}%` }}
                title={`P50: ${pt.p50}ms | P95: ${pt.p95}ms`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Recent Stream Snapshot */}
      <div className="p-6 rounded-2xl bg-[#0d121d] border border-slate-800">
        <div className="font-semibold text-white text-sm mb-4">Latest Ingested Stream Events</div>
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
            <div className="text-slate-500 py-4 text-center">No telemetry events captured yet. Inject a heartbeat above.</div>
          )}
        </div>
      </div>
    </div>
  );
}
