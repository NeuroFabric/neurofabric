import { useState } from 'react';
import { useTelemetry } from '../context/TelemetryContext';
import { Search, ChevronDown, ChevronRight, Pause, Play, Trash2 } from 'lucide-react';

export function AlertsPage() {
  const { logs, clearLogs } = useTelemetry();
  const [activeSeverities, setActiveSeverities] = useState<string[]>(['INFO', 'WARNING', 'CRITICAL']);
  const [search, setSearch] = useState('');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  const toggleSeverity = (sev: string) => {
    setActiveSeverities((prev) =>
      prev.includes(sev) ? prev.filter((s) => s !== sev) : [...prev, sev]
    );
  };

  const filtered = logs.filter((log: any) => {
    const matchesSev = activeSeverities.includes(log.severity);
    const matchesSearch =
      log.service.toLowerCase().includes(search.toLowerCase()) ||
      log.message.toLowerCase().includes(search.toLowerCase());
    return matchesSev && matchesSearch;
  });

  return (
    <div className="p-8 space-y-6 max-w-7xl font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Live Alerts Stream</h1>
          <p className="text-xs text-slate-400 mt-1">
            Real-time EventBridge feed. In-flight DLP scrubbed prior to SQLite audit persistence.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`px-3 py-2 rounded-xl text-xs font-medium border flex items-center space-x-1.5 transition ${
              isPaused
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
                : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white'
            }`}
          >
            {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{isPaused ? 'Resume Stream' : 'Pause Live Tail'}</span>
          </button>
          <button
            onClick={clearLogs}
            className="px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-rose-400 rounded-xl text-xs font-medium flex items-center space-x-1.5 transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear Buffer</span>
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="p-3 rounded-2xl bg-[#0d121d] border border-slate-800/80 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-2">
          {['INFO', 'WARNING', 'CRITICAL'].map((sev) => {
            const active = activeSeverities.includes(sev);
            return (
              <button
                key={sev}
                onClick={() => toggleSeverity(sev)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition border ${
                  active
                    ? sev === 'CRITICAL'
                      ? 'bg-rose-950 text-rose-300 border-rose-800'
                      : sev === 'WARNING'
                      ? 'bg-amber-950 text-amber-300 border-amber-800'
                      : 'bg-cyan-950 text-cyan-300 border-cyan-800'
                    : 'bg-slate-900 text-slate-500 border-slate-800'
                }`}
              >
                {sev}
              </button>
            );
          })}
        </div>

        <div className="flex-1 max-w-md relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search service names, messages, or hashes..."
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
          />
        </div>
      </div>

      {/* Stream List */}
      <div className="rounded-2xl bg-[#0d121d] border border-slate-800/80 overflow-hidden divide-y divide-slate-800/60 font-mono text-xs">
        {filtered.map((log: any) => {
          const isExpanded = expandedRow === log.id;
          return (
            <div key={log.id} className="transition hover:bg-slate-900/40">
              <div
                onClick={() => setExpandedRow(isExpanded ? null : log.id)}
                className="p-4 flex items-center justify-between gap-4 cursor-pointer"
              >
                <div className="flex items-center space-x-3 truncate">
                  <span className="text-slate-500 text-[10px] shrink-0">
                    {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : 'NOW'}
                  </span>
                  <span
                    className={`font-bold shrink-0 px-2 py-0.5 rounded text-[10px] ${
                      log.severity === 'CRITICAL'
                        ? 'bg-rose-950 text-rose-400 border border-rose-800'
                        : 'bg-cyan-950 text-cyan-400 border border-cyan-800'
                    }`}
                  >
                    {log.severity}
                  </span>
                  <span className="text-slate-200 font-bold shrink-0">{log.service}:</span>
                  <span className="text-slate-300 truncate">{log.message}</span>
                </div>
                <div className="flex items-center space-x-3 shrink-0">
                  {log.dlpScrubbed && (
                    <span className="text-[10px] bg-amber-950 text-amber-300 border border-amber-800 px-2 py-0.5 rounded font-bold">
                      DLP SCRUBBED
                    </span>
                  )}
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-slate-500" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-500" />
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="p-4 bg-slate-950 border-t border-slate-800/80 space-y-2">
                  <div className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">
                    Raw Telemetry Frame (EventBridge Envelope)
                  </div>
                  <pre className="p-3 rounded-xl bg-[#07090e] border border-slate-800 text-[11px] text-slate-300 overflow-x-auto leading-relaxed">
                    {JSON.stringify(log, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="p-12 text-center text-slate-500">
            No events match current filter criteria. Telemetry stream is active.
          </div>
        )}
      </div>
    </div>
  );
}
