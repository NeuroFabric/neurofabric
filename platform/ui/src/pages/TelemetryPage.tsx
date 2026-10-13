import { useState } from 'react';
import { useTelemetry } from '../context/TelemetryContext';

export function TelemetryPage() {
  const { logs, triggerProbe } = useTelemetry();
  const [filter, setFilter] = useState('');

  const filteredLogs = logs.filter(
    (l) =>
      l.service.toLowerCase().includes(filter.toLowerCase()) ||
      l.message.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Live Telemetry & In-Flight DLP</h1>
          <p className="text-xs text-slate-400 mt-1">Real-time event stream with automated credential redacting</p>
        </div>
        <button
          onClick={() => triggerProbe('billing-core', true)}
          className="px-4 py-2 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-xs text-rose-300 font-semibold rounded-xl transition"
        >
          Test Leaked Credential Probe
        </button>
      </div>

      {/* Filter Toolbar */}
      <div className="flex items-center space-x-4">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter service, severity, or message contents..."
          className="flex-1 bg-[#0d121d] border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
        />
        <div className="text-xs font-mono text-slate-400">
          Showing <span className="text-cyan-400 font-bold">{filteredLogs.length}</span> events
        </div>
      </div>

      {/* Live Log Table */}
      <div className="rounded-2xl bg-[#0d121d] border border-slate-800 overflow-hidden">
        <div className="divide-y divide-slate-800/80 font-mono text-xs">
          {filteredLogs.map((log, i) => (
            <div key={i} className="p-4 hover:bg-slate-900/40 transition flex items-center justify-between gap-4">
              <div className="flex items-center space-x-3 truncate">
                <span className="text-slate-500 text-[10px] w-20 shrink-0">
                  {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : 'NOW'}
                </span>
                <span
                  className={`font-bold shrink-0 ${
                    log.severity === 'CRITICAL' ? 'text-rose-400' : 'text-cyan-400'
                  }`}
                >
                  [{log.severity}]
                </span>
                <span className="text-slate-200 font-semibold shrink-0">{log.service}</span>
                <span className="text-slate-400 truncate">{log.message}</span>
              </div>
              {log.dlpScrubbed && (
                <span className="shrink-0 text-[10px] bg-amber-950 text-amber-300 border border-amber-800/60 px-2 py-0.5 rounded font-bold">
                  DLP SCRUBBED
                </span>
              )}
            </div>
          ))}
          {filteredLogs.length === 0 && (
            <div className="p-8 text-center text-slate-500">No logs match the current filter.</div>
          )}
        </div>
      </div>
    </div>
  );
}
